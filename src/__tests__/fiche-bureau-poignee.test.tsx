// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La poignée des fiches film et série du bureau (20/09/2026, `useSheetGrip`), regardée rendue.
 *
 * `decisions-partagees.test.ts` exigeait `useSheetGrip(requestClose, useIsTouch()` écrit dans chacune
 * des deux fiches. La même règle, sur la fiche : au doigt, une poignée en haut, qui déplace la fiche
 * entière et la referme — par la même fermeture que le bouton Retour ; à la souris, aucune ; sous une
 * fiche posée par-dessus, aucune.
 */
const S = vi.hoisted(() => ({ touch: true }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: () => new Promise(() => {}),
}));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => S.touch }));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], seasonOf: () => undefined }) }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: undefined, watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null, similarRowKeyNav: () => false }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const MOVIE = { radarrId: 3, tmdbId: 99, jellyfinItemId: "a".repeat(32), title: "Un film", year: 1973, posterUrl: null, backdropUrl: null, logoUrl: null, genres: [] } as unknown as CinemaMovie;
const SERIES = { sonarrId: 7, tmdbId: 1234, jellyfinItemId: "b".repeat(32), title: "Une série", year: 1990, posterUrl: null, backdropUrl: null, logoUrl: null, genres: [] } as unknown as CinemaSeries;

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;
const root = () => document.body.querySelector<HTMLElement>("body > div[style*='z-index: 47']")!;
/** La poignée : la bande du haut, et son trait. */
const grip = () => document.body.querySelector<HTMLElement>("div[aria-hidden] > div.h-1.w-10")?.parentElement ?? null;
const pointer = (el: Element, type: string, clientY: number) =>
  act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY })));

beforeEach(() => {
  S.touch = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe.each([
  ["la fiche film du bureau", (onClose: () => void, underneath = false) => <CinemaMovieDetail item={MOVIE} onClose={onClose} underneath={underneath} />],
  ["la fiche série du bureau", (onClose: () => void, underneath = false) => <CinemaSeriesDetail item={SERIES} onClose={onClose} underneath={underneath} />],
] as const)("%s", (_name, draw) => {
  it("au doigt : une poignée en haut, posée avant le bouton Retour, qui déplace la fiche entière", () => {
    render(withSwr(draw(vi.fn())));
    const g = grip();
    expect(g).not.toBeNull();
    expect(g!.parentElement).toBe(root());
    const back = Array.from(root().querySelectorAll("button")).find((b) => b.textContent?.includes("cinema.back"))!;
    expect(g!.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    pointer(g!, "pointerdown", 100);
    pointer(g!, "pointermove", 140);
    expect(root().style.transform).toBe("translateY(40px)");
  });

  it("tirée assez loin, elle referme la fiche par sa fermeture", () => {
    const onClose = vi.fn();
    render(withSwr(draw(onClose)));
    const g = grip()!;
    pointer(g, "pointerdown", 100);
    pointer(g, "pointermove", 400);
    pointer(g, "pointerup", 400);
    act(() => void vi.runAllTimers());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("à la souris : aucune poignée, et rien de posé sur la fiche", () => {
    S.touch = false;
    render(withSwr(draw(vi.fn())));
    expect(grip()).toBeNull();
    expect(root().style.transform).toBe("");
  });

  it("sous une fiche posée par-dessus : aucune poignée", () => {
    render(withSwr(draw(vi.fn(), true)));
    expect(grip()).toBeNull();
  });
});

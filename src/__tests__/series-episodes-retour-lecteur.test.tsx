// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * « Plus d'épisodes » reste ouvert sous le lecteur quand un épisode y est lancé (18/10/2026). Le lecteur
 * refermé, l'habillage des fiches du bureau (`useDesktopSheetShell`) rendait le focus à la première action
 * de la fiche série — « Lire », caché sous l'écran des épisodes : les flèches ne bougeaient plus rien, et
 * Entrée lançait l'épisode « À suivre » au lieu de celui qu'on voyait (13/11/2026). Le focus revient sur
 * l'écran des épisodes.
 */
const S = vi.hoisted(() => ({ mode: "full" as "idle" | "full", play: vi.fn() }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: S.mode, play: S.play }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({
  usePlayerEnabled: () => true,
  usePlayerEnabledState: () => true,
  usePlayerServerFallback: () => true,
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
const EPISODES = {
  seasons: [
    {
      seasonNumber: 1,
      episodes: [
        { jellyfinItemId: "e1", seasonNumber: 1, episodeNumber: 1, title: "Pilote", overview: null, thumbnailUrl: null, runtimeMinutes: 45, runtimeTicks: 27_000_000_000, watched: false, resumeTicks: null },
      ],
    },
  ],
  nextEpisode: { itemId: "e1", title: "Pilote", seasonNumber: 1, episodeNumber: 1 },
};
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (key: string) => (key.endsWith("/episodes") ? EPISODES : new Promise(() => {})),
}));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({
  usePlayerSeriesRequests: () => ({ seasons: [], seasonOf: () => undefined }),
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: { known: false }, watched: false, known: false, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({
  useCinemaSimilar: () => [],
  CinemaSimilarRow: () => null,
  similarRowKeyNav: () => false,
}));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const SERIES = {
  sonarrId: 7,
  tmdbId: 1234,
  jellyfinItemId: "jfs",
  title: "Une série",
  year: 1990,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaSeries;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  document.body.innerHTML = "";
});

const frames = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  });

describe("« Plus d'épisodes » sous le lecteur, le lecteur refermé (13/11/2026)", () => {
  it("le focus revient sur l'écran des épisodes, pas sur « Lire » de la série caché dessous", async () => {
    S.mode = "full";
    window.history.replaceState(null, "", "/#serie=7&episodes=1&tab=series");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const draw = () => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />
      </SWRConfig>
    );
    const { rerender } = render(draw());
    await waitFor(() => expect(document.body.querySelector('[data-episode-season="true"]')).not.toBeNull());
    await frames();
    // Le film occupait l'écran, et le focus était dans le lecteur.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    S.mode = "idle";
    rerender(draw());
    await frames();
    const active = document.activeElement as HTMLElement | null;
    expect(active?.closest("[data-detail-actions]")).toBeNull();
    expect(active?.getAttribute("data-episode-season")).toBe("true");
  });

  /**
   * Série A, série B par « Titres similaires » posée dessus, « Plus d'épisodes » dans B : l'adresse dit
   * `episodes=1` pour les deux fiches montées. A, recouverte, dessinait aussi son écran des épisodes, dont
   * les flèches passaient avant celles de B (règle 2 des fiches, 13/11/2026).
   */
  it("une fiche série recouverte ne dessine pas son propre écran des épisodes", async () => {
    S.mode = "idle";
    window.history.replaceState(null, "", "/#serie=8&episodes=1&tab=series");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const OTHER = { ...SERIES, sonarrId: 8, jellyfinItemId: "jfs2", title: "Une autre" } as unknown as CinemaSeries;
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CinemaSeriesDetail key="a" item={SERIES} onClose={vi.fn()} underneath />
        <CinemaSeriesDetail key="b" item={OTHER} onClose={vi.fn()} />
      </SWRConfig>
    );
    await waitFor(() => expect(document.body.querySelector('[data-episode-season="true"]')).not.toBeNull());
    await frames();
    expect(document.body.querySelectorAll('[data-episode-season="true"]')).toHaveLength(1);
  });

  /**
   * Échap, puis Entrée sur l'épisode focalisé pendant les 220 ms de la sortie : l'épisode partait, et la
   * fermeture différée retirait aussitôt l'entrée d'historique du lecteur (règle 2 des fiches, 13/11/2026).
   */
  it("pendant sa sortie, l'écran des épisodes ne lance plus d'épisode", async () => {
    S.mode = "idle";
    S.play.mockClear();
    window.history.replaceState(null, "", "/#serie=7&episodes=1&tab=series");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />
      </SWRConfig>
    );
    await waitFor(() => expect(document.body.querySelector('[data-episode-item="true"]')).not.toBeNull());
    await frames();
    const episode = document.body.querySelector<HTMLButtonElement>('[data-episode-item="true"]')!;
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(episode);
    expect(S.play).not.toHaveBeenCalled();
  });
});

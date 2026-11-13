// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { SWRConfig } from "swr";

/**
 * Les entrées de la fenêtre « Détails » (DECISIONS.md §152, 13/11/2026) : le rond « i » de la fiche du
 * téléphone, le rond « Infos » de la rangée du bureau, et les pastilles de qualité — **sur les fiches de
 * films seulement**. Une série, la fiche d'un lien de partage et les bannières de l'accueil n'ont rien.
 */
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }), usePlaybackMode: () => "idle" }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
const fetched: string[] = [];
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (url: string) => {
    fetched.push(url);
    return new Promise(() => {});
  },
}));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [], seasonOf: () => undefined }) }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
vi.mock("@/components/ask/AskTitleControl", () => ({ AskTitleControl: () => null }));

import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { DetailIconActions } from "@/components/cinema/DetailIconActions";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const MOVIE = {
  radarrId: 1,
  tmdbId: 603,
  jellyfinItemId: "jf1",
  title: "Matrix",
  year: 1999,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
  imdbRating: null,
  quality: { resolution: 2160, dynamicRange: "DV" },
} as unknown as CinemaMovie;

const SERIES = {
  sonarrId: 2,
  tmdbId: 1399,
  jellyfinItemId: "jf2",
  title: "Dark",
  year: 2017,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
  imdbRating: null,
  quality: { resolution: 2160, dynamicRange: "HDR" },
} as unknown as CinemaSeries;

const drawPhone = (item: CinemaMovie | CinemaSeries, mediaType: "movies" | "series") =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CinemaMobileDetail item={item} mediaType={mediaType} onClose={vi.fn()} />
    </SWRConfig>
  );

afterEach(() => {
  cleanup();
  fetched.length = 0;
});

describe("la fiche du téléphone", () => {
  it("un film : un rond « i » posé juste à gauche de la croix, et des pastilles qui ouvrent la fenêtre", async () => {
    drawPhone(MOVIE, "movies");
    const info = document.body.querySelector<HTMLElement>("[data-details-open]")!;
    expect(info).not.toBeNull();
    expect(info.getAttribute("aria-label")).toBe("cinema.details.title");
    expect(info.className).toContain("right-14");
    const badges = [...document.body.querySelectorAll<HTMLButtonElement>("button[data-quality-open]")];
    expect(badges.map((b) => b.textContent)).toEqual(["4K", "Dolby Vision"]);
    // Rien n'est demandé au chargement de la fiche : seulement à l'ouverture.
    expect(fetched.filter((u) => u.startsWith("/api/jellyfin/streams/"))).toEqual([]);
    await act(async () => {
      fireEvent.click(badges[0]);
    });
    expect(document.body.querySelector("[data-title-details]")).not.toBeNull();
    expect(fetched.filter((u) => u.startsWith("/api/jellyfin/streams/"))).toEqual(["/api/jellyfin/streams/jf1?tmdb=603"]);
  });

  it("une série : ni rond « i », ni pastille touchable", () => {
    drawPhone(SERIES, "series");
    expect(document.body.querySelector("[data-details-open]")).toBeNull();
    expect(document.body.querySelector("button[data-quality-open]")).toBeNull();
    expect(screen.getByText("4K").tagName).toBe("SPAN");
  });
});

describe("QualityBadges", () => {
  it("restent du texte sans `onOpen` — les autres appelants ne changent pas", () => {
    render(<QualityBadges quality={{ resolution: 2160, dynamicRange: "DV" }} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("4K").tagName).toBe("SPAN");
  });

  it("deviennent des boutons à la taille exacte de la pastille avec `onOpen`", () => {
    const onOpen = vi.fn();
    render(<QualityBadges quality={{ resolution: 2160 }} onOpen={onOpen} openLabel="Détails" />);
    const badge = screen.getByRole("button", { name: "4K — Détails" });
    // Les mêmes marges que la pastille de texte : aucune zone de toucher élargie.
    expect(badge.className).toContain("px-1.5 py-px");
    expect(badge.className).not.toMatch(/\b(p|px|py|-m|m)-[2-9]\b|before:|after:|min-h-|min-w-/);
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("la rangée des ronds du bureau", () => {
  const noop = () => {};
  it("ajoute « Infos » en dernier quand la fiche de film le passe", () => {
    const onDetails = vi.fn();
    render(<DetailIconActions watched={{ on: false, onClick: noop }} list={{ on: false, onClick: noop }} askItemId="jf1" onDetails={onDetails} />);
    const round = document.body.querySelector<HTMLButtonElement>('[data-round-action="details"]')!;
    expect(round.getAttribute("aria-label")).toBe("cinema.details.title");
    expect(round.parentElement!.querySelector("[data-round-caption]")!.textContent).toBe("cinema.details.caption");
    const actions = [...document.body.querySelectorAll("[data-round-action]")].map((b) => b.getAttribute("data-round-action"));
    expect(actions[actions.length - 1]).toBe("details");
    fireEvent.click(round);
    expect(onDetails).toHaveBeenCalledTimes(1);
  });

  it("n'a pas de rond « Infos » sans `onDetails` (la fiche série)", () => {
    render(<DetailIconActions watched={{ on: false, onClick: noop }} list={null} askItemId="jf2" />);
    expect(document.body.querySelector('[data-round-action="details"]')).toBeNull();
  });
});

describe("qui passe quoi", () => {
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  it("seule la fiche de film du bureau passe `onDetails` et rend la fenêtre", () => {
    const movie = code("src/components/cinema/CinemaMovieDetail.tsx");
    expect(movie).toMatch(/onDetails=/);
    expect(movie).toMatch(/<TitleDetailsSheet\b/);
    expect(movie).toMatch(/<QualityBadges[^>]*onOpen=/);
    const series = code("src/components/cinema/CinemaSeriesDetail.tsx");
    expect(series).not.toMatch(/onDetails=|TitleDetails|<QualityBadges[^>]*onOpen=/);
  });

  it("ni la fiche d'un lien de partage ni les bannières de l'accueil", () => {
    for (const f of [
      "src/components/shareGuest/ShareTitleSheet.tsx",
      "src/components/cinema/CinemaHero.tsx",
      "src/components/cinema/mobile/CinemaMobileHero.tsx",
    ]) {
      const src = code(f);
      expect(src, f).not.toMatch(/TitleDetails/);
      expect(src, f).not.toMatch(/<QualityBadges[^>]*onOpen=/);
    }
  });
});

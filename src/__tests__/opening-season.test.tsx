// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La saison ouverte par défaut, sur les deux écrans (DECISIONS.md §38).
 *
 * Une série de la bibliothèque n'a que sa saison 15 ; Sonarr en signale 1 à 14 manquantes. Le
 * bureau ouvrait la 15 (saisons possédées seules, au montage), le téléphone l'ouvrait aussi puis
 * sautait à la 1 quand la liste des manquants arrivait — il recalculait sur la réunion des deux à
 * chaque rendu (29/09/2026).
 */
let missingSeasons: { seasonNumber: number; episodes: { released: boolean }[] }[] = [];
vi.mock("@/lib/usePlayerSeriesRequests", () => ({
  usePlayerSeriesRequests: () => ({
    seasons: missingSeasons,
    seasonOf: (n: number) => missingSeasons.find((s) => s.seasonNumber === n),
  }),
}));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: { n?: number }) => (v?.n != null ? `${k}:${v.n}` : k),
  useLocale: () => ({ locale: "fr" }),
}));
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
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => null }));
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { openingSeason } from "@/lib/seasonOrder";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { CinemaEpisodeBrowser } from "@/components/cinema/CinemaEpisodeBrowser";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

const S15: CinemaSeason = {
  seasonNumber: 15,
  episodes: [
    {
      jellyfinItemId: "ep1501",
      seasonNumber: 15,
      episodeNumber: 1,
      title: "Premier de la quinze",
      overview: null,
      thumbnailUrl: null,
      runtimeMinutes: 45,
      runtimeTicks: null,
      watched: false,
      resumeTicks: null,
    },
  ],
};
const MANQUANTES = Array.from({ length: 14 }, (_, i) => ({ seasonNumber: i + 1, episodes: [{ released: true }] }));

const SERIES = {
  sonarrId: 7,
  tmdbId: 1234,
  jellyfinItemId: "jfs",
  title: "Longue série",
  year: 1990,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaSeries;

beforeEach(() => {
  missingSeasons = [];
});
afterEach(() => cleanup());

describe("openingSeason", () => {
  it("ouvre la première saison possédée, même si des saisons plus anciennes manquent", () => {
    expect(openingSeason([15], MANQUANTES.map((s) => s.seasonNumber))).toBe(15);
  });
  it("garde la règle de `defaultSeason` : les spéciaux en dernier", () => {
    expect(openingSeason([0, 2, 3], [1])).toBe(2);
    expect(openingSeason([0], [1])).toBe(0);
  });
  it("ne retombe sur les manquantes que sans aucune saison possédée", () => {
    expect(openingSeason([], [0, 3, 4])).toBe(3);
    expect(openingSeason([], [])).toBeNull();
  });
});

describe("la saison ouverte, sur les deux écrans", () => {
  // La pastille active est la seule en `bg-white text-ink`.
  const activePill = () =>
    [...document.body.querySelectorAll("button")].find((b) => b.className.includes("bg-white text-ink"))?.textContent;

  it("le téléphone ouvre S15, et n'en bouge pas quand les manquantes arrivent", () => {
    const tree = () => (
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          fallback: { "/api/cinema/series/jfs/episodes": { seasons: [S15], nextEpisode: null } },
        }}
      >
        <CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />
      </SWRConfig>
    );
    const { rerender } = render(tree());
    expect(document.body.textContent).toContain("Premier de la quinze");

    // La réponse de Sonarr arrive après celle de Jellyfin.
    missingSeasons = MANQUANTES;
    act(() => rerender(tree()));
    expect(activePill()).toContain("cinema.season:15");
    expect(document.body.textContent).toContain("Premier de la quinze");
  });

  it("le bureau ouvre S15, manquantes déjà connues ou non", () => {
    missingSeasons = MANQUANTES;
    render(
      <CinemaEpisodeBrowser title="Longue série" seasons={[S15]} sonarrId={7} onClose={vi.fn()} onPlayEpisode={vi.fn()} />
    );
    // Le focus posé au montage choisit aussi la saison (`onFocus`) : il doit tomber sur la même.
    const active = [...document.body.querySelectorAll('[data-episode-season="true"]')].find((b) =>
      b.className.includes("ring-1")
    );
    expect(active?.getAttribute("data-season")).toBe("15");
  });
});

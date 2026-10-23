// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * « Télécharger » et « Lire le fichier téléchargé » sur la fiche d'un film, au bureau et au téléphone
 * (audit des fiches, 23/10/2026, V7).
 *
 * Le hors ligne n'est ouvert que par sa propre décision, `useOfflineDownloadsEnabled` (§109). La fiche
 * du téléphone y ajoutait une garde à elle, la lecture intégrée (`playerEnabled &&`), que celle du
 * bureau n'a pas : deux endroits pour une décision. Ici on ouvre le hors ligne en fermant la lecture
 * intégrée, et les deux fiches doivent montrer la même chose.
 */
let downloadState: "none" | "done" = "none";
const DONE = {
  id: "dl1",
  itemId: "a".repeat(32),
  radarrId: 3,
  title: "Un film",
  year: 1973,
  runtimeSeconds: 7200,
  quality: "standard",
  codec: "h264",
  audioIndex: 1,
  audioLabel: "Français",
  audioTracks: [],
  generation: 1,
  expectedBytes: 1e9,
  serverBytes: 1e9,
  serverDone: true,
  state: "done",
  bytes: 1e9,
  positionSeconds: 0,
};
vi.mock("@/lib/offline/useOfflineEnabled", () => ({ useOfflineDownloadsEnabled: () => true }));
vi.mock("@/lib/offline/deviceStore", () => ({ deviceStoreSupported: () => true }));
vi.mock("@/lib/unsentPosition", () => ({ findUnsentPositions: () => [] }));
vi.mock("@/lib/offline/downloads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline/downloads")>()),
  initOfflineDownloads: async () => {},
  useOfflineDownloadFor: () => (downloadState === "done" ? DONE : null),
  adoptOnlinePosition: vi.fn(),
}));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => false, usePlayerEnabledState: () => false, usePlayerServerFallback: () => true }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }) }));
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
let mobile = false;
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => mobile, useIsShortViewport: () => false, useIsTouch: () => false }));
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
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const MOVIE = {
  radarrId: 3,
  tmdbId: 99,
  jellyfinItemId: DONE.itemId,
  title: "Un film",
  year: 1973,
  runtimeMinutes: 120,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaMovie;

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;
const has = (text: string) => Array.from(document.body.querySelectorAll("button")).some((b) => b.textContent?.includes(text));

beforeEach(() => {
  downloadState = "none";
  mobile = false;
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe.each([
  ["le bureau", false, () => <CinemaMovieDetail item={MOVIE} onClose={vi.fn()} />],
  ["le téléphone", true, () => <CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} />],
] as const)("%s, hors ligne ouvert, lecture intégrée fermée", (_name, isPhone, draw) => {
  it("propose « Télécharger »", () => {
    mobile = isPhone;
    render(withSwr(draw()));
    expect(has("player.downloads.download")).toBe(true);
  });

  it("propose « Lire le fichier téléchargé » d'un film téléchargé", () => {
    mobile = isPhone;
    downloadState = "done";
    render(withSwr(draw()));
    expect(has("player.downloads.fileDownloaded")).toBe(true);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * Le bouton de téléchargement de chaque ligne d'épisode et « Télécharger la saison » (§109,
 * 19/10/2026), sur la liste du bureau et sur la fiche du téléphone.
 *
 * Les lignes étaient des boutons entiers : le bouton de téléchargement est posé à côté, jamais
 * dedans. Les flèches de la liste du bureau gardent leur parcours, et gagnent une colonne à droite.
 */
const play = vi.fn();
const remove = vi.fn<(id: string) => Promise<void>>(async () => {});
let list: OfflineDownload[] = [];

vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play }) }));
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
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], seasonOf: () => undefined }) }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({ useJellyfinItemState: () => ({ watched: false, known: true, busy: false, toggleWatched: vi.fn() }) }));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => null }));
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
// Le téléchargement hors ligne ouvert, et l'état des téléchargements de l'appareil tenu par le test.
vi.mock("@/lib/offline/useOfflineEnabled", () => ({ useOfflineDownloadsEnabled: () => true }));
vi.mock("@/lib/offline/deviceStore", () => ({ deviceStoreSupported: () => true, deviceStore: {}, resetDeviceStore: vi.fn() }));
vi.mock("@/lib/offline/downloads", () => ({
  initOfflineDownloads: async () => {},
  useOfflineDownloads: () => list,
  useOfflineDownloadFor: (itemId: string | null | undefined) => list.find((d) => d.itemId === itemId) ?? null,
  offlineDownloadById: (id: string) => list.find((d) => d.id === id) ?? null,
  offlineEpisodesOf: () => list,
  removeOfflineDownload: (id: string) => remove(id),
  startOfflineDownload: vi.fn(async () => {}),
}));

import { CinemaEpisodeBrowser } from "@/components/cinema/CinemaEpisodeBrowser";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import type { CinemaSeason, CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const ep = (n: number): CinemaEpisode => ({
  jellyfinItemId: `ep10${n}`,
  seasonNumber: 1,
  episodeNumber: n,
  title: `Épisode ${n}`,
  overview: null,
  thumbnailUrl: null,
  runtimeMinutes: 45,
  runtimeTicks: 27_000_000_000,
  watched: false,
  resumeTicks: null,
});
const S1: CinemaSeason = { seasonNumber: 1, episodes: [ep(1), ep(2), ep(3), ep(4)] };

const download = (itemId: string, change: Partial<OfflineDownload>): OfflineDownload =>
  ({
    id: `job-${itemId}`,
    itemId,
    radarrId: null,
    title: `Une série — ${itemId}`,
    year: null,
    runtimeSeconds: 2700,
    quality: "standard",
    codec: "h264",
    audioIndex: 1,
    audioLabel: "Français",
    audioTracks: [],
    generation: 1,
    expectedBytes: 1000,
    serverBytes: 0,
    serverDone: false,
    bytes: 0,
    state: "preparing",
    error: null,
    createdAt: 1,
    positionSeconds: 0,
    hasPoster: false,
    ...change,
  }) as OfflineDownload;

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

const states = () => [...document.querySelectorAll<HTMLElement>('[data-episode-download="true"]')].map((b) => b.dataset.downloadState);
const nestedButtons = () => document.querySelectorAll("button button").length;
const item = (n: number) => document.querySelectorAll<HTMLElement>('[data-episode-item="true"]')[n];
const dl = (n: number) => document.querySelectorAll<HTMLElement>('[data-episode-download="true"]')[n];

beforeEach(() => {
  play.mockClear();
  remove.mockClear();
  list = [
    download("ep102", { state: "preparing" }),
    download("ep103", { state: "downloading", bytes: 420 }),
    download("ep104", { state: "done", bytes: 1000, serverBytes: 1000, serverDone: true, positionSeconds: 600 }),
  ];
});
afterEach(() => cleanup());

function renderBrowser(onClose = vi.fn()) {
  render(<CinemaEpisodeBrowser title="Une série" seasons={[S1]} sonarrId={7} seriesItemId="jfs" posterUrl={null} onClose={onClose} onPlayEpisode={play} />);
  return onClose;
}

describe("liste des épisodes du bureau", () => {
  it("chaque ligne dit son état, sans bouton dans un bouton", () => {
    renderBrowser();
    expect(states()).toEqual(["none", "preparing", "downloading", "done"]);
    expect(nestedButtons()).toBe(0);
    // L'épisode reste le bouton de la ligne, et lance la lecture en ligne comme avant.
    fireEvent.click(item(3));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ jellyfinItemId: "ep104" }));
  });

  it("sans identifiant de série, rien de neuf n'est rendu", () => {
    render(<CinemaEpisodeBrowser title="Une série" seasons={[S1]} sonarrId={7} onClose={vi.fn()} onPlayEpisode={play} />);
    expect(states()).toEqual([]);
    expect(document.querySelector('[data-season-download="true"]')).toBeNull();
  });

  it("→ va au téléchargement de la ligne, ← en revient, ↑/↓ restent dans leur colonne", () => {
    renderBrowser();
    item(1).focus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(2));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(document.activeElement).toBe(dl(2));
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(dl(3));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(item(3));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(document.activeElement?.getAttribute("data-episode-season")).toBe("true");
  });

  it("un épisode téléchargé : lire le fichier, ou le supprimer après confirmation — et Échap ne ferme que la feuille", async () => {
    const onClose = renderBrowser();
    fireEvent.click(dl(3));
    const playItem = await screen.findByText("player.downloads.playDownloaded");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(playItem);
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "ep104", offline: { id: "job-ep104" }, resumeAt: 600 }));

    fireEvent.click(dl(3));
    fireEvent.click(await screen.findByText("player.downloads.remove"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("player.downloads.confirmRemove");
    expect(remove).not.toHaveBeenCalled();
    const confirm = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.includes("player.downloads.remove"))!;
    fireEvent.click(confirm);
    expect(remove).toHaveBeenCalledWith("job-ep104");
  });

  it("un épisode en cours s'annule sans confirmation ; un épisode absent ouvre la fenêtre de choix", async () => {
    renderBrowser();
    fireEvent.click(dl(2));
    fireEvent.click(await screen.findByText("player.downloads.cancel"));
    expect(remove).toHaveBeenCalledWith("job-ep103");
    fireEvent.click(dl(0));
    expect(await screen.findByText("player.downloads.sheetTitle")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /player.downloads.autoNext/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("« Télécharger la saison » en tête de la saison, et « Saison téléchargée » quand tout est là", () => {
    renderBrowser();
    const season = document.querySelector<HTMLButtonElement>('[data-season-download="true"]')!;
    expect(season.textContent).toContain("player.downloads.downloadSeason");
    expect(season.disabled).toBe(false);
    cleanup();
    list = S1.episodes.map((e) => download(e.jellyfinItemId, { state: "done" }));
    renderBrowser();
    const done = document.querySelector<HTMLButtonElement>('[data-season-download="true"]')!;
    expect(done.textContent).toContain("player.downloads.seasonDone");
    expect(done.disabled).toBe(true);
  });
});

describe("fiche du téléphone", () => {
  it("une seule saison : « Télécharger la saison » quand même, et un bouton par ligne à côté de l'épisode", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, fallback: { "/api/cinema/series/jfs/episodes": { seasons: [S1], nextEpisode: null } } }}>
        <CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />
      </SWRConfig>
    );
    await act(async () => {});
    expect(document.querySelector('[data-season-download="true"]')).not.toBeNull();
    expect(states().slice(0, 3)).toEqual(["none", "preparing", "downloading"]);
    expect(nestedButtons()).toBe(0);
    // La ligne lance toujours l'épisode en ligne.
    const row = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Épisode 1"))!;
    fireEvent.click(row);
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "ep101" }));
    expect(play.mock.calls[0][0].offline).toBeUndefined();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * La page des téléchargements (bêta, DECISIONS.md §109) : le classement films / séries → saisons →
 * épisodes, partagé par le panneau du cinéma et l'entrée hors ligne, et ce que chaque ligne permet.
 */

const play = vi.fn();
const remove = vi.fn(async (id: string) => void id);
let list: OfflineDownload[] = [];

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${Object.values(v).join(",")}` : k),
  useLocale: () => ({ locale: "fr", setLocale: async () => {} }),
}));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ play }) }));
vi.mock("@/lib/offline/deviceStore", () => ({ deviceStore: { readPoster: async () => null }, deviceStoreSupported: () => true }));
vi.mock("@/lib/offline/downloads", () => ({
  useOfflineDownloads: () => list,
  offlineAccount: () => "louis",
  removeOfflineDownload: (id: string) => remove(id),
  useOfflineDownloadFor: () => null,
  initOfflineDownloads: async () => {},
  startOfflineDownload: async () => {},
}));

import { groupOfflineDownloads, offlineRemainingSeconds } from "@/lib/offline/downloadGroups";
import { OfflineDownloadsView } from "@/components/offline/OfflineDownloadsView";

function download(over: Partial<OfflineDownload>): OfflineDownload {
  return {
    id: "x",
    itemId: "item",
    radarrId: 1,
    title: "Titre",
    year: 2001,
    runtimeSeconds: 6000,
    quality: "standard",
    codec: "h264",
    audioIndex: 1,
    audioLabel: "Français — 5.1",
    audioTracks: [],
    generation: 1,
    expectedBytes: 1_000_000_000,
    serverBytes: 1_000_000_000,
    serverDone: true,
    bytes: 1_000_000_000,
    state: "done",
    error: null,
    createdAt: 1,
    positionSeconds: 0,
    hasPoster: false,
    ...over,
  };
}

const episode = (id: string, season: number, number: number, createdAt: number, sonarrId: number | null = 7, seriesTitle = "Ted Lasso") =>
  download({
    id,
    itemId: `ep-${id}`,
    radarrId: null,
    title: `${seriesTitle} — S0${season}E0${number}`,
    createdAt,
    episode: { sonarrId, seriesTitle, seasonNumber: season, episodeNumber: number, episodeTitle: `Épisode ${number}`, autoNext: false },
  });

beforeEach(() => {
  list = [];
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("groupOfflineDownloads", () => {
  it("les films du plus récent au plus ancien, les épisodes par série, saison puis numéro", () => {
    const groups = groupOfflineDownloads([
      download({ id: "f1", createdAt: 1 }),
      episode("e3", 2, 1, 5),
      download({ id: "f2", createdAt: 9 }),
      episode("e2", 1, 2, 3),
      episode("e1", 1, 1, 4),
      episode("o1", 1, 1, 2, null, "The Office"),
    ]);
    expect(groups.films.map((d) => d.id)).toEqual(["f2", "f1"]);
    expect(groups.series.map((s) => s.title)).toEqual(["Ted Lasso", "The Office"]);
    const ted = groups.series[0];
    expect(ted.sonarrId).toBe(7);
    expect(ted.seasons.map((s) => [s.season, s.episodes.map((d) => d.id)])).toEqual([
      [1, ["e1", "e2"]],
      [2, ["e3"]],
    ]);
    expect(ted.first.id).toBe("e1");
    expect(groups.series[1].key).toBe("tThe Office");
  });

  it("le temps restant n'existe qu'après trente secondes lues", () => {
    expect(offlineRemainingSeconds(download({ positionSeconds: 10 }))).toBeNull();
    expect(offlineRemainingSeconds(download({ positionSeconds: 1200 }))).toBe(4800);
    expect(offlineRemainingSeconds(download({ positionSeconds: 1200, runtimeSeconds: 0 }))).toBeNull();
  });
});

describe("OfflineDownloadsView", () => {
  it("films puis séries, chaque saison sous son titre", () => {
    list = [download({ id: "f1", title: "Dune" }), episode("e1", 1, 1, 4), episode("e2", 2, 3, 5)];
    render(<OfflineDownloadsView />);
    expect(screen.getByText("player.downloads.films")).toBeTruthy();
    expect(screen.getByText("player.downloads.series")).toBeTruthy();
    expect(screen.getByText("Ted Lasso")).toBeTruthy();
    expect(screen.getByText("player.downloads.season:1")).toBeTruthy();
    expect(screen.getByText("player.downloads.season:2")).toBeTruthy();
    expect(screen.getByText("Épisode 3")).toBeTruthy();
  });

  it("Lire part du fichier téléchargé, à la position gardée ; grisé tant que rien n'est lisible", () => {
    list = [
      download({ id: "f1", itemId: "dune", title: "Dune", positionSeconds: 1200 }),
      download({ id: "f2", itemId: "arrival", title: "Arrival", state: "preparing", bytes: 0, serverBytes: 0, createdAt: 0 }),
    ];
    render(<OfflineDownloadsView />);
    const [ready, waiting] = screen.getAllByRole("button", { name: /player\.downloads\.play/ });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ready);
    expect(play).toHaveBeenCalledWith({ itemId: "dune", title: "Dune", resumeAt: 1200, offline: { id: "f1" } });
    // Arrêté à 20 min, 1 h 20 restantes : ce qu'on veut savoir avant de reprendre.
    expect(screen.getByText(/player\.downloads\.stoppedAt:20min · cinema\.timeRemaining:1h20/)).toBeTruthy();
  });

  it("une barre de progression et son pourcentage pendant le téléchargement", () => {
    list = [download({ id: "f1", state: "downloading", bytes: 420_000_000, serverDone: false })];
    render(<OfflineDownloadsView />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
  });

  it("supprimer demande toujours confirmation", async () => {
    list = [download({ id: "f1", title: "Dune" })];
    render(<OfflineDownloadsView />);
    fireEvent.click(screen.getByRole("button", { name: "player.downloads.remove" }));
    expect(remove).not.toHaveBeenCalled();
    const confirm = screen.getAllByRole("button", { name: /player\.downloads\.remove/ }).at(-1)!;
    await act(async () => fireEvent.click(confirm));
    expect(remove).toHaveBeenCalledWith("f1");
  });

  it("« Ouvrir la fiche » seulement dans le cinéma : le film par Radarr, la série par Sonarr", () => {
    list = [download({ id: "f1", radarrId: 42 }), episode("e1", 1, 1, 4)];
    const { rerender } = render(<OfflineDownloadsView />);
    expect(screen.queryByRole("button", { name: "player.downloads.open" })).toBeNull();
    const open = vi.fn();
    rerender(<OfflineDownloadsView onOpenTitle={open} />);
    fireEvent.click(screen.getByRole("button", { name: "player.downloads.open" }));
    fireEvent.click(screen.getByRole("button", { name: "player.downloads.openSeries" }));
    expect(open.mock.calls).toEqual([[{ type: "movie", id: 42 }], [{ type: "series", id: 7 }]]);
  });

  it("la place prise par les téléchargements, et ce que l'appareil dit pouvoir encore accorder", async () => {
    Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: async () => ({ quota: 50e9, usage: 10e9 }) } });
    list = [download({ id: "f1", bytes: 2e9 })];
    await act(async () => {
      render(<OfflineDownloadsView />);
    });
    expect(screen.getByText(/player\.downloads\.storageUsed:2\s?Go/)).toBeTruthy();
    expect(screen.getByText(/player\.downloads\.storageFree:40\s?Go/)).toBeTruthy();
  });
});

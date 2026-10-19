// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * Le lecteur hors ligne d'un épisode (§109) : à mi-épisode, le suivant se demande — une fois ; vu à
 * 95 %, l'épisode est noté vu en partant (pas pendant le générique) ; « Épisode suivant » lance le
 * fichier de l'appareil s'il y est, sinon la lecture en ligne.
 */
const play = vi.fn();
const nextDownload = vi.fn<(d: OfflineDownload) => Promise<"started">>(async () => "started");
const markWatched = vi.fn<(id: string) => Promise<void>>(async () => {});
let list: OfflineDownload[] = [];
let controls: { nextEpisode: { itemId: string; title: string } | null; onAdvance: () => void } | null = null;

vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "full", play, close: vi.fn(), minimize: vi.fn(), expand: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/components/PlayerControls", () => ({
  PlayerControls: (props: { nextEpisode: { itemId: string; title: string } | null; onAdvance: () => void }) => {
    controls = props;
    return null;
  },
}));
vi.mock("@/components/MiniPlayer", () => ({ MiniPlayerChrome: () => null, useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 0, height: 0 }, isDragging: false, handlers: {} }) }));
vi.mock("@/components/PlaybackInfoPanel", () => ({ PlaybackInfoPanel: () => null }));
vi.mock("@/lib/playerHistory", () => ({ usePlayerBackClose: () => {} }));
vi.mock("@/lib/usePlayerFocus", () => ({ usePlayerFocus: () => {} }));
vi.mock("@/lib/reportClientError", () => ({ reportClientError: vi.fn() }));
vi.mock("@/lib/offline/deviceStore", () => ({ deviceStore: {}, deviceStoreSupported: () => true }));
vi.mock("@/lib/offline/offlineEngine", () => ({
  OfflineEngine: class {
    stage = "premier fragment";
    open() {
      return Promise.resolve();
    }
    close() {}
    describe() {
      return { mime: null, fragments: 0, lastFragmentAt: null };
    }
  },
}));
vi.mock("@/lib/offline/downloads", () => ({
  useOfflineDownloads: () => list,
  offlineDownloadById: (id: string) => list.find((d) => d.id === id) ?? null,
  offlineAccount: () => "acc",
  saveOfflinePosition: vi.fn(),
  markOfflineWatched: (id: string) => markWatched(id),
}));
vi.mock("@/lib/offline/episodeDownloads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline/episodeDownloads")>()),
  downloadNextEpisode: (d: OfflineDownload) => nextDownload(d),
}));

import { OfflinePlayerHost } from "@/components/offline/OfflinePlayerHost";

const episode = (id: string, n: number, change: Partial<OfflineDownload> = {}): OfflineDownload =>
  ({
    id,
    itemId: `item-${id}`,
    episode: {
      sonarrId: 7,
      seriesTitle: "Une série",
      seasonNumber: 1,
      episodeNumber: n,
      episodeTitle: `Épisode ${n}`,
      autoNext: true,
      seriesItemId: "jfs",
      audioLanguage: "fr",
      next: { itemId: `item-e${n + 1}`, title: `Épisode ${n + 1}` },
    },
    radarrId: null,
    title: `Une série — S01E0${n} · Épisode ${n}`,
    year: null,
    runtimeSeconds: 2000,
    quality: "standard",
    codec: "h264",
    audioIndex: 1,
    audioLabel: "Français",
    audioTracks: [],
    generation: 1,
    expectedBytes: 100,
    serverBytes: 100,
    serverDone: true,
    bytes: 100,
    state: "done",
    error: null,
    createdAt: 1,
    positionSeconds: 0,
    hasPoster: false,
    ...change,
  }) as OfflineDownload;

async function mount() {
  const view = render(<OfflinePlayerHost session={{ itemId: "item-e1", title: "x", offline: { id: "e1" }, openId: 1 }} mode="full" />);
  await act(async () => {});
  const video = document.querySelector("video")!;
  let now = 0;
  Object.defineProperty(video, "currentTime", { get: () => now, set: (v: number) => (now = v), configurable: true });
  const at = (seconds: number) => {
    now = seconds;
    video.dispatchEvent(new Event("timeupdate"));
  };
  return { view, at };
}

beforeEach(() => {
  play.mockClear();
  nextDownload.mockClear();
  markWatched.mockClear();
  controls = null;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("lecteur hors ligne d'un épisode", () => {
  it("demande le suivant à la moitié, une seule fois", async () => {
    list = [episode("e1", 1)];
    const { at } = await mount();
    at(999);
    expect(nextDownload).not.toHaveBeenCalled();
    at(1000);
    at(1100);
    expect(nextDownload).toHaveBeenCalledTimes(1);
    expect(nextDownload.mock.calls[0][0]).toMatchObject({ id: "e1" });
  });

  it("sans le téléchargement automatique, rien n'est demandé", async () => {
    const plain = episode("e1", 1);
    list = [{ ...plain, episode: { ...plain.episode!, autoNext: false } }];
    const { at } = await mount();
    at(1500);
    expect(nextDownload).not.toHaveBeenCalled();
  });

  it("vu au seuil de Jellyfin : noté vu à la fermeture, pas pendant le générique", async () => {
    list = [episode("e1", 1)];
    const { at, view } = await mount();
    at(1950);
    expect(markWatched).not.toHaveBeenCalled();
    view.unmount();
    expect(markWatched).toHaveBeenCalledWith("e1");
  });

  it("arrêté avant le seuil de Jellyfin (90 % par défaut) : pas noté vu", async () => {
    list = [episode("e1", 1)];
    const { at, view } = await mount();
    at(1700);
    view.unmount();
    expect(markWatched).not.toHaveBeenCalled();
  });

  it("« Épisode suivant » : le fichier de l'appareil s'il y est", async () => {
    list = [episode("e1", 1), episode("e2", 2, { itemId: "item-e2" })];
    await mount();
    expect(controls?.nextEpisode).toEqual({ itemId: "item-e2", title: "Une série — S01E02 · Épisode 2" });
    controls!.onAdvance();
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "item-e2", resumeAt: 0, offline: { id: "e2" } }));
  });

  it("« Épisode suivant » : en ligne s'il n'est pas sur l'appareil, rien sans réseau", async () => {
    list = [episode("e1", 1)];
    await mount();
    expect(controls?.nextEpisode).toEqual({ itemId: "item-e2", title: "Épisode 2" });
    controls!.onAdvance();
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "item-e2", resumeAt: 0 }));
    expect(play.mock.calls[0][0].offline).toBeUndefined();
    cleanup();

    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await mount();
    expect(controls?.nextEpisode).toBeNull();
    online.mockRestore();
  });
});

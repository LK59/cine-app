// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * Le lecteur hors ligne fermé deux fois dans le même tour (double appui, Retour puis croix) : une
 * seule fermeture (§36, §114). Sa garde lisait l'état React `closing`, que le second appel voyait
 * encore faux — deux arrêts chez Jellyfin, deux relectures des vues, deux `playback.close`. Audit des
 * fusions du 23/10/2026 (DECISIONS.md §116). Harnais de offline-player-episodes.test.tsx.
 */
const play = vi.fn();
const closePlayback = vi.fn();
const nextDownload = vi.fn<(d: OfflineDownload) => Promise<"started">>(async () => "started");
const markWatched = vi.fn<(id: string) => Promise<void>>(async () => {});
let list: OfflineDownload[] = [];
let controls: { onClose: () => void } | null = null;
/** L'arrêt chez Jellyfin, et la relecture des vues qui l'attend. */
const stopReporting = vi.fn(async () => {});
const refreshAfterPlayback = vi.fn(async () => {});

vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "full", play, close: closePlayback, minimize: vi.fn(), expand: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/components/PlayerControls", () => ({
  PlayerControls: (props: { onClose: () => void }) => {
    controls = props;
    return null;
  },
}));
vi.mock("@/components/MiniPlayer", () => ({ MiniPlayerChrome: () => null, useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 0, height: 0 }, isDragging: false, handlers: {} }) }));
vi.mock("@/components/PlaybackInfoPanel", () => ({ PlaybackInfoPanel: () => null }));
vi.mock("@/lib/playerHistory", () => ({ usePlayerBackClose: () => {} }));
vi.mock("@/lib/usePlayerFocus", () => ({ usePlayerFocus: () => {} }));
vi.mock("@/lib/reportClientError", () => ({ reportClientError: vi.fn() }));
vi.mock("@/lib/usePlaybackSession", () => ({ usePlaybackSession: () => ({ stop: stopReporting }) }));
vi.mock("@/lib/swr", async (original) => ({
  ...(await original<typeof import("@/lib/swr")>()),
  refreshAfterPlayback: (...args: unknown[]) => refreshAfterPlayback(...(args as [])),
}));
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
  closePlayback.mockClear();
  nextDownload.mockClear();
  markWatched.mockClear();
  stopReporting.mockClear();
  refreshAfterPlayback.mockClear();
  controls = null;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("le lecteur hors ligne ne se ferme qu'une fois (F1, §36)", () => {
  it("deux fermetures dans le même tour : un arrêt, une relecture, un close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      list = [episode("e1", 1)];
      await mount();
      expect(controls).not.toBeNull();
      act(() => {
        controls!.onClose();
        controls!.onClose();
      });
      await act(async () => void vi.advanceTimersByTime(500));
      expect(stopReporting).toHaveBeenCalledTimes(1);
      expect(refreshAfterPlayback).toHaveBeenCalledTimes(1);
      expect(closePlayback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("une fermeture : un arrêt, une relecture, un close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      list = [episode("e1", 1)];
      await mount();
      act(() => controls!.onClose());
      await act(async () => void vi.advanceTimersByTime(500));
      expect(stopReporting).toHaveBeenCalledTimes(1);
      expect(refreshAfterPlayback).toHaveBeenCalledTimes(1);
      expect(closePlayback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

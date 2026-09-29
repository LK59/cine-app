// @vitest-environment jsdom
// Le volume mémorisé, rendu au lecteur natif comme au lecteur serveur.
//
// `PlayerControls` écrit le volume et le muet à chaque changement, et seul le lecteur serveur les
// relisait : dans le lecteur natif — celui de presque toutes les séances — chaque film repartait à
// plein volume, son coupé oublié. Harnais repris de ExperimentalPlayerHost.test.tsx, réduit à ce
// que ce test demande.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key.split(".").pop() ?? key,
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/webcodecs/trace", () => ({ trace: vi.fn(), traceKeepAcrossReset: vi.fn(), traceRecent: () => [] }));
vi.mock("@/lib/webcodecs/pathSelector", () => ({ NATIVE_PATH: "raison du choix" }));
vi.mock("@/components/ExperimentalPlayerReport", () => ({ ExperimentalPlayerReport: () => <div data-testid="report" /> }));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));
const stopPlaybackNow = vi.fn(() => Promise.resolve());
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: stopPlaybackNow, resume: vi.fn() }),
}));
vi.mock("@/components/player/PlayerEndScreen", () => ({ PlayerEndScreen: () => null }));

const advance = vi.fn();
const close = vi.fn();
vi.mock("@/components/PlaybackProvider", () => ({
  usePlayback: () => ({ close, minimize: vi.fn(), expand: vi.fn(), advance, session: null }),
}));

vi.mock("@/components/PlayerControls", () => ({
  PlayerControls: (props: { loading: boolean }) => <div data-testid="controls" data-loading={String(props.loading)} />,
}));

let swr: { data: Record<string, unknown> | undefined; error: unknown };
vi.mock("swr", () => ({ default: () => swr }));
const refreshAfterPlayback = vi.fn(async () => {});
vi.mock("@/lib/swr", async (original) => ({
  ...(await original<typeof import("@/lib/swr")>()),
  refreshAfterPlayback: (...a: unknown[]) => refreshAfterPlayback(...(a as [])),
}));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
vi.mock("@/lib/webcodecs/memoryReserve", () => ({ MemoryReserve: { start: () => ({ stop: vi.fn() }) } }));
vi.mock("@/lib/resumeCache/keepOnStop", () => ({ keepOnStop: vi.fn(async () => 0) }));

function fakeRemux() {
  return {
    audioTracks: [{ number: 1, codecId: "A_AAC", language: "fre", name: null, isDefault: true, isForced: false }],
    subtitleTracks: [],
    currentAudioTrack: 1,
    canCarryAudio: vi.fn(() => true),
    requestAudioTrack: vi.fn(() => null),
    selectSubtitleTrack: vi.fn(),
    subtitleAt: vi.fn(() => null),
    diagnostics: {},
    destroy: vi.fn(),
    lost: false,
    lossReport: vi.fn(() => ({})),
    position: 0,
  };
}
vi.mock("@/lib/webcodecs/remuxPlayback", () => ({
  probePlaybackPath: vi.fn(async () => ({ path: "remux", start: async () => fakeRemux(), discard: vi.fn() })),
}));

import { VOLUME_STORAGE_KEY, restoreRememberedVolume } from "@/lib/rememberedVolume";
import { noteWatching } from "@/lib/resumeRewind";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";

function mount() {
  return render(
    <ExperimentalPlayerHost
      session={{ itemId: "ep-1", title: "Épisode 1", resumeAt: 0, openId: 7, getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }) } as never}
      mode="full"
      onFallback={() => {}}
    />
  );
}
const ready = () => waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  noteWatching("ep-1");
  swr = {
    data: { streamUrl: "/s.mkv", container: "mkv", refusedReason: null, externalSubtitles: [], video: { codec: "h264", width: 1, height: 1, bitDepth: 8, rangeType: "SDR" }, introSkip: null, creditsStart: null },
    error: undefined,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      typeof url === "string" && url.startsWith("/api/jellyfin/playback-state/")
        ? { ok: true, json: async () => ({ resumeSeconds: 0, preferences: null }) }
        : { ok: true, text: async () => "", json: async () => ({}) }
    )
  );
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("le volume mémorisé", () => {
  it("est rendu au lecteur natif comme au lecteur serveur", async () => {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: 0.3, muted: true }));
    mount();
    await ready();
    const video = document.querySelector("video")!;
    expect(video.volume).toBe(0.3);
    expect(video.muted).toBe(true);
  });

  it("n'est posé qu'une fois : un volume changé pendant la séance n'est pas écrasé au redessin", async () => {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: 0.3, muted: false }));
    const view = mount();
    await ready();
    const video = document.querySelector("video")!;
    video.volume = 0.8;
    view.rerender(
      <ExperimentalPlayerHost
        session={{ itemId: "ep-1", title: "Épisode 1", resumeAt: 0, openId: 7, getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }) } as never}
        mode="mini"
        onFallback={() => {}}
      />
    );
    expect(document.querySelector("video")).toBe(video);
    expect(video.volume).toBe(0.8);
  });

  it("une valeur illisible laisse l'élément à son volume", () => {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, "{pas du json");
    const video = document.createElement("video");
    restoreRememberedVolume(video);
    expect(video.volume).toBe(1);
    expect(video.muted).toBe(false);
    window.localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: 7, muted: "oui" }));
    restoreRememberedVolume(video);
    expect(video.volume).toBe(1);
    expect(video.muted).toBe(false);
  });
});

// @vitest-environment jsdom
// Une séance close (la croix) n'enchaîne plus l'épisode suivant et ne se ferme qu'une fois — hôte natif.
// Harnais de ExperimentalPlayerHost.test.tsx, avec des doubles de PlaybackProvider / PlayerControls
// qui exposent advance / close / onAdvance.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";

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
  VOLUME_STORAGE_KEY: "cine:player-volume",
  PlayerControls: (props: { loading: boolean; onClose?: () => void; onAdvance: () => void }) => (
    <div data-testid="controls" data-loading={String(props.loading)}>
      <button onClick={props.onClose}>fermer</button>
      {/* Ce que fait le décompte de PlayerControls quand il atteint zéro : onAdvance(). */}
      <button onClick={props.onAdvance}>suivant</button>
    </div>
  ),
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

const logged = (kind: string) =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([url]) => url === "/api/player/log")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
    .filter((entry) => entry.kind === kind);

describe("hôte natif — une séance close ne se rouvre pas et ne se ferme qu'une fois", () => {
  it("le décompte qui atteint zéro pendant le fondu de fermeture n'enchaîne pas l'épisode suivant", async () => {
    mount();
    await ready();
    act(() => void fireEvent.click(screen.getByText("fermer")));
    // Dans les 200 ms du fondu, le décompte de PlayerControls arrive à zéro → onAdvance().
    // Avant : l'épisode 2 était monté puis démonté aussitôt (faux `stop unmount`, flash).
    act(() => void fireEvent.click(screen.getByText("suivant")));
    expect(advance).not.toHaveBeenCalled();
    expect(logged("stop").map((e) => e.fields.why)).toEqual(["close"]);
  });

  it("deux appuis sur la croix ne relancent qu'une relecture des vues", async () => {
    mount();
    await ready();
    act(() => void fireEvent.click(screen.getByText("fermer")));
    act(() => void fireEvent.click(screen.getByText("fermer")));
    expect(refreshAfterPlayback).toHaveBeenCalledTimes(1);
    expect(stopPlaybackNow).toHaveBeenCalledTimes(1);
  });

  it("l'épisode suivant s'enchaîne toujours quand rien n'a été fermé", async () => {
    mount();
    await ready();
    act(() => void fireEvent.click(screen.getByText("suivant")));
    expect(advance).toHaveBeenCalledWith({ itemId: "ep-2", title: "Épisode 2" });
  });
});

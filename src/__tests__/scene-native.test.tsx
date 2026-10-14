// @vitest-environment jsdom
// Une scène ouverte depuis une réplique (DECISIONS.md §91), hôte natif : rien rapporté à Jellyfin,
// ni relecture des vues, ni épisode suivant, ni octets gardés pour une reprise — `scene: true` au
// journal. Harnais de native-close-once.test.tsx.
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
/** Ce que l'hôte confie à `usePlaybackSession`, rendu après rendu : `null` veut dire « rien à Jellyfin ». */
const reported: unknown[] = [];
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: (_position: unknown, info: unknown) => {
    reported.push(info);
    return { stop: stopPlaybackNow, reportNow: () => {}, resume: vi.fn() };
  },
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
vi.mock("@/lib/webcodecs/memoryReserve", () => ({ reservePlanFacts: () => ({}), MemoryReserve: { start: () => ({ stop: vi.fn() }) } }));
vi.mock("@/lib/resumeCache/keepOnStop", () => ({ keepOnStop: vi.fn(async () => 0) }));
const forgetResumeCache = vi.fn();
vi.mock("@/lib/resumeCache/diskChunks", async (original) => ({
  ...(await original<typeof import("@/lib/resumeCache/diskChunks")>()),
  forgetResumeCache: (...a: unknown[]) => forgetResumeCache(...a),
}));

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
import { keepOnStop } from "@/lib/resumeCache/keepOnStop";
import { __resetSceneClocks } from "@/lib/sceneMode";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";

const onFallback = vi.fn();
function mount(scene: boolean, openId: number) {
  return render(
    <ExperimentalPlayerHost
      session={{ itemId: "ep-1", title: "Épisode 1", resumeAt: 1800, openId, ...(scene ? { scene: true } : {}), getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }) } as never}
      mode="full"
      onFallback={(...a: unknown[]) => onFallback(...a)}
    />
  );
}
const ready = () => waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

beforeEach(() => {
  vi.clearAllMocks();
  __resetSceneClocks();
  reported.length = 0;
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
});

const logged = (kind: string) =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([url]) => url === "/api/player/log")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
    .filter((entry) => entry.kind === kind);

describe("hôte natif — une scène ouverte depuis une réplique", () => {
  it("ne confie rien à Jellyfin, ne relit pas les vues et ne garde rien pour une reprise", async () => {
    mount(true, 91);
    await ready();
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.every((info) => info === null)).toBe(true);
    expect(logged("start")[0]?.fields).toMatchObject({ scene: true });

    act(() => void fireEvent.click(screen.getByText("fermer")));
    expect(logged("stop")[0]?.fields).toMatchObject({ scene: true, why: "close" });
    expect(logged("stop")[0]?.fields.sceneNormal).toBeUndefined();
    expect(refreshAfterPlayback).not.toHaveBeenCalled();
    expect(keepOnStop).not.toHaveBeenCalled();
  });

  it("n'enchaîne pas l'épisode suivant", async () => {
    mount(true, 92);
    await ready();
    act(() => void fireEvent.click(screen.getByText("suivant")));
    expect(advance).not.toHaveBeenCalled();
  });

  it("une lecture ordinaire, elle, se rapporte à Jellyfin et relit les vues", async () => {
    mount(false, 93);
    await ready();
    await waitFor(() => expect(reported.some((info) => info !== null)).toBe(true));
    expect(logged("start")[0]?.fields.scene).toBeUndefined();
    act(() => void fireEvent.click(screen.getByText("fermer")));
    expect(refreshAfterPlayback).toHaveBeenCalledTimes(1);
  });

  // Relecture du 14/10/2026 : une scène regardée jusqu'au bout effaçait les octets gardés pour la
  // reprise instantanée du vrai visionnage, qu'elle ne remplace pas.
  it("regardée jusqu'à la fin : ne touche pas au cache de reprise ; une lecture ordinaire, si", async () => {
    mount(true, 94);
    await ready();
    act(() => void fireEvent(document.querySelector("video")!, new Event("ended")));
    expect(forgetResumeCache).not.toHaveBeenCalled();
    cleanup();

    mount(false, 95);
    await ready();
    act(() => void fireEvent(document.querySelector("video")!, new Event("ended")));
    expect(forgetResumeCache).toHaveBeenCalledWith("ep-1");
  });

  // Une zone illisible pendant une scène (§93) : le relais au lecteur serveur est un relais comme les
  // autres — la scène passe avec lui (même `openId`, la même horloge de scène côté serveur), et la
  // ligne le dit.
  it("une zone illisible pendant une scène : le relais garde la scène", async () => {
    const { probePlaybackPath } = await import("@/lib/webcodecs/remuxPlayback");
    mount(true, 96);
    await ready();
    const options = (probePlaybackPath as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as {
      onError: (m: string, k?: string, f?: Record<string, unknown>) => void;
    };
    const message = "zone illisible dans le fichier vers 1830,0 s (octet 99)";
    act(() => options.onError(message, "playback", { unreadableZone: true, zoneByte: 99, zoneSeconds: 1830, resumeAt: 1825 }));
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toBe(message);
    expect(onFallback.mock.calls[0][1]).toMatchObject({ resumeAt: 1825 });
    expect(logged("fallback")[0]?.fields).toMatchObject({ scene: true, reason: message, zoneByte: 99 });
  });
});

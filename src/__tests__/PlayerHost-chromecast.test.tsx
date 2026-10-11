// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";

// DECISIONS.md §64 — l'aiguillage de PlayerHost : un relais de diffusion marqué Chromecast monte la
// télécommande ; une diffusion AirPlay garde le lecteur serveur, comme avant.

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/useWakeLock", () => ({ useWakeLock: () => {} }));
vi.mock("@/lib/playerBench/bridge", () => ({ publishHandedOver: () => {} }));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));
vi.mock("@/components/PlaybackInfoPanel", () => ({ PlaybackInfoPanel: () => null }));
vi.mock("@/components/ExperimentalPlayerHost", () => ({ ExperimentalPlayerHost: () => <div data-testid="natif" /> }));
vi.mock("@/components/PlayerControls", () => ({ PlayerControls: () => <div data-testid="commandes" /> }));
const chromecastProps: Record<string, unknown>[] = [];
vi.mock("@/components/player/ChromecastPlayer", () => ({
  ChromecastPlayer: (props: Record<string, unknown>) => {
    chromecastProps.push(props);
    return <div data-testid="chromecast" />;
  },
}));

const playback = { session: null as null | Record<string, unknown>, mode: "full", close: vi.fn(), advance: vi.fn(), minimize: vi.fn(), expand: vi.fn() };
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => playback, PLAYER_RELOAD_INTENT_KEY: "reload-intent" }));
vi.mock("@/lib/useLegacyPlayer", () => ({ useLegacyPlayer: () => ({ legacy: false }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
let takeover: unknown = null;
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: [], negotiating: false, reason: null, takeover, stepAside: vi.fn(), stepBack: vi.fn(), returning: null }),
}));
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: vi.fn() }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: vi.fn(async () => {}) }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: vi.fn(async () => {}), resume: vi.fn() }),
  stopOrphanSession: vi.fn(async () => {}),
}));

import { PlayerHost } from "@/components/PlayerHost";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ playSessionId: "p", mediaSourceId: "m", manifestUrl: "/x.m3u8", audioTracks: [], subtitleTracks: [] }), text: async () => "" })));
  playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film" };
  chromecastProps.length = 0;
  takeover = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PlayerHost et le Chromecast", () => {
  it("sans relais : le lecteur natif", () => {
    render(<PlayerHost />);
    expect(screen.getByTestId("natif")).toBeTruthy();
    expect(screen.queryByTestId("chromecast")).toBeNull();
  });

  it("un relais de diffusion vers le Chromecast : la télécommande, avec la position et le retour", () => {
    takeover = { resumeAt: 600, audioStreamIndex: 2, cast: true, castTarget: "chromecast", owner: playback.session };
    render(<PlayerHost />);
    expect(screen.getByTestId("chromecast")).toBeTruthy();
    expect(screen.queryByTestId("natif")).toBeNull();
    expect(chromecastProps[0]).toMatchObject({ mode: "full", takeover: { resumeAt: 600, audioStreamIndex: 2, castTarget: "chromecast" } });
    expect(typeof chromecastProps[0].onCastEnded).toBe("function");
  });

  it("une diffusion AirPlay : le lecteur serveur, comme avant", async () => {
    takeover = { resumeAt: 600, cast: true, owner: playback.session };
    render(<PlayerHost />);
    expect(screen.queryByTestId("chromecast")).toBeNull();
    expect(screen.queryByTestId("natif")).toBeNull();
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
  });
});

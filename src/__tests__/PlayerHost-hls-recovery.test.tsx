// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

// La récupération d'hls.js dans le lecteur serveur (Chrome, Firefox, Edge) — DECISIONS §67.
// Caractérisation : une erreur fatale réseau relance le chargement (6 fois au plus, délai doublé
// jusqu'à 15 s), une erreur média appelle `recoverMediaError` (3 fois au plus), puis l'écran
// d'erreur ; un fragment bufferisé remet les deux compteurs à zéro. Et la boucle prouvée que ce
// dernier point ouvre, que le registre des tentatives devra arrêter.

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
vi.mock("@/components/PlayerControls", () => ({
  VOLUME_STORAGE_KEY: "volume",
  PlayerControls: () => <div data-testid="commandes" />,
}));
const playback = {
  session: null as null | Record<string, unknown>,
  mode: "full" as "full" | "mini" | "closed",
  close: vi.fn(),
  advance: vi.fn(),
  minimize: vi.fn(),
  expand: vi.fn(),
};
vi.mock("@/components/PlaybackProvider", () => ({
  usePlayback: () => playback,
  PLAYER_RELOAD_INTENT_KEY: "reload-intent",
}));
vi.mock("@/lib/useLegacyPlayer", () => ({ useLegacyPlayer: () => ({ legacy: true }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: [], negotiating: false, reason: null, takeover: null, stepAside: vi.fn(), stepBack: vi.fn(), returning: null }),
}));
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: () => {} }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
// Pas de HLS natif : hls.js.
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => false }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: async () => {}, resume: () => {} }),
  stopOrphanSession: async () => {},
}));

/** L'instance hls.js simulée : ses écouteurs, et ce que le lecteur lui demande. */
type Listener = (event: string, data: Record<string, unknown>) => void;
const fake = {
  listeners: new Map<string, Listener[]>(),
  startLoad: vi.fn(),
  recoverMediaError: vi.fn(),
};
vi.mock("hls.js", () => {
  class Hls {
    static isSupported = () => true;
    static Events = { FRAG_BUFFERED: "hlsFragBuffered", ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed", LEVEL_LOADED: "hlsLevelLoaded" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" };
    bandwidthEstimate = 0;
    audioTracks = [];
    on(event: string, cb: Listener) {
      fake.listeners.set(event, [...(fake.listeners.get(event) ?? []), cb]);
    }
    off() {}
    loadSource() {}
    attachMedia() {}
    startLoad() {
      fake.startLoad();
    }
    recoverMediaError() {
      fake.recoverMediaError();
    }
    destroy() {}
  }
  return { default: Hls };
});

import { PlayerHost } from "@/components/PlayerHost";

const reponse = {
  playSessionId: "seance-jf",
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
  audioTracks: [],
  subtitleTracks: [],
  title: "Film",
};

function emit(event: string, data: Record<string, unknown> = {}) {
  act(() => {
    for (const cb of fake.listeners.get(event) ?? []) cb(event, data);
  });
}
const fatal = (type: string) => emit("hlsError", { fatal: true, type });

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/jellyfin/playback/start"
        ? { ok: true, status: 200, json: async () => reponse }
        : { ok: true, status: 200, json: async () => ({}), text: async () => "" }
    )
  );
  playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film" };
  fake.listeners = new Map();
  fake.startLoad.mockClear();
  fake.recoverMediaError.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mounted() {
  render(<PlayerHost />);
  await waitFor(() => expect(fake.listeners.get("hlsError")?.length).toBeTruthy());
}

describe("hls.js — caractérisation", () => {
  it("erreur média : recoverMediaError trois fois, puis l'écran d'erreur", async () => {
    await mounted();
    for (let i = 0; i < 3; i++) fatal("mediaError");
    expect(fake.recoverMediaError).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain("player.playbackInterrupted");
    fatal("mediaError");
    expect(fake.recoverMediaError).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(document.body.textContent).toContain("player.playbackInterrupted"));
  });

  it("erreur réseau : six relances au délai doublé (plafonné à 15 s), puis l'écran d'erreur", async () => {
    await mounted();
    vi.useFakeTimers();
    const delays = [1000, 2000, 4000, 8000, 15000, 15000];
    for (const delay of delays) {
      fatal("networkError");
      const before = fake.startLoad.mock.calls.length;
      act(() => void vi.advanceTimersByTime(delay - 1));
      expect(fake.startLoad.mock.calls.length).toBe(before);
      act(() => void vi.advanceTimersByTime(1));
      expect(fake.startLoad.mock.calls.length).toBe(before + 1);
    }
    fatal("networkError");
    act(() => void vi.advanceTimersByTime(20_000));
    expect(fake.startLoad).toHaveBeenCalledTimes(6);
    expect(document.body.textContent).toContain("player.playbackInterruptedCheckConnection");
  });

  it("un fragment bufferisé rend tout leur budget aux deux compteurs", async () => {
    await mounted();
    for (let i = 0; i < 3; i++) fatal("mediaError");
    emit("hlsFragBuffered");
    fatal("mediaError");
    expect(fake.recoverMediaError).toHaveBeenCalledTimes(4);
    expect(document.body.textContent).not.toContain("player.playbackInterrupted");
  });
});

describe("boucle (a)2 — les compteurs remis à zéro par chaque fragment", () => {
  // Prouvée et non corrigée (§67, étape 2 : observation seulement) : une erreur média qui revient
  // après chaque fragment est récupérée sans fin. À basculer en `it` quand le registre sera actif.
  it.fails("une erreur média qui revient après chaque fragment n'est pas récupérée sans fin", async () => {
    await mounted();
    for (let cycle = 0; cycle < 10; cycle++) {
      emit("hlsFragBuffered");
      fatal("mediaError");
    }
    expect(fake.recoverMediaError.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

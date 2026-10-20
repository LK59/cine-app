// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor, fireEvent } from "@testing-library/react";

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
vi.mock("@/lib/useAccountPreferences", () => ({ useAccountPreferencesLoader: () => {} }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
// Le lecteur serveur s'ouvre parce que le natif lui a passé ces titres (`handedOver`) : le choix
// « lecteur legacy » par compte, qui l'ouvrait d'office, a disparu le 13/10/2026.
const SERVEUR = vi.hoisted(() => ["film", "ep-1", "ep-2"]);
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: SERVEUR, negotiating: false, reason: null, takeover: null, stepAside: vi.fn(), stepBack: vi.fn(), returning: null }),
}));
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: () => {} }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
// Pas de HLS natif : hls.js.
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => false }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: async () => {}, reportNow: () => {}, resume: () => {} }),
  stopOrphanSession: async () => {},
}));

/** L'instance hls.js simulée : ses écouteurs, et ce que le lecteur lui demande. */
type Listener = (event: string, data: Record<string, unknown>) => void;
const fake = {
  listeners: new Map<string, Listener[]>(),
  startLoad: vi.fn(),
  recoverMediaError: vi.fn(),
  detachMedia: vi.fn(),
  stopLoad: vi.fn(),
};
vi.mock("hls.js", () => {
  class Hls {
    static isSupported = () => true;
    static Events = { FRAG_BUFFERED: "hlsFragBuffered", ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed", LEVEL_LOADED: "hlsLevelLoaded", MEDIA_DETACHING: "hlsMediaDetaching" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" };
    bandwidthEstimate = 0;
    audioTracks = [];
    on(event: string, cb: Listener) {
      fake.listeners.set(event, [...(fake.listeners.get(event) ?? []), cb]);
    }
    off() {}
    loadSource() {}
    attachMedia() {}
    startLoad(...args: unknown[]) {
      fake.startLoad(...args);
    }
    stopLoad() {
      fake.stopLoad();
    }
    detachMedia() {
      fake.detachMedia();
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
  fake.detachMedia.mockClear();
  fake.stopLoad.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Les corps des négociations envoyées, dans l'ordre. */
function negotiations(): Record<string, unknown>[] {
  return (vi.mocked(fetch).mock.calls as unknown as [string, RequestInit | undefined][])
    .filter(([url]) => url === "/api/jellyfin/playback/start")
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
}

async function mounted() {
  render(<PlayerHost />);
  await waitFor(() => expect(fake.listeners.get("hlsError")?.length).toBeTruthy());
}

describe("hls.js — caractérisation", () => {
  it("erreur média : recoverMediaError trois fois, puis l'image en H.264 — et l'écran d'erreur si elle échoue aussi", async () => {
    await mounted();
    for (let i = 0; i < 3; i++) fatal("mediaError");
    expect(fake.recoverMediaError).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain("player.playbackInterrupted");
    fatal("mediaError");
    expect(fake.recoverMediaError).toHaveBeenCalledTimes(3);
    // Un décodeur qui refuse l'image (Android, 19/10/2026) : une négociation de plus, image en H.264.
    await waitFor(() => expect(negotiations().at(-1)).toMatchObject({ videoH264Only: true, forceAudioTranscode: true }), { timeout: 3000 });
    expect(document.body.textContent).not.toContain("player.playbackInterrupted");
    const count = negotiations().length;
    await waitFor(() => expect(fake.listeners.get("hlsError")?.length).toBeGreaterThan(1));
    for (let i = 0; i < 4; i++) fatal("mediaError");
    await waitFor(() => expect(document.body.textContent).toContain("player.playbackInterrupted"));
    // Une fois par ouverture : pas de seconde marche.
    expect(negotiations()).toHaveLength(count);
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

  it("un fragment bufferisé rend tout leur budget aux deux compteurs — quand l'élément tient une image", async () => {
    await mounted();
    elementAt(120);
    for (let i = 0; i < 3; i++) fatal("mediaError");
    emit("hlsFragBuffered");
    fatal("mediaError");
    expect(fake.recoverMediaError).toHaveBeenCalledTimes(4);
    expect(document.body.textContent).not.toContain("player.playbackInterrupted");
  });
});

describe("boucle (a)2 — les compteurs remis à zéro par chaque fragment", () => {
  // Prouvée le 11/10 (§67), corrigée le 20/10/2026 : un fragment ne rend le budget des erreurs média
  // que si l'élément tient une image. Sur un décodeur qui refusait tout, 109 reprises en 20 s.
  it("une erreur média qui revient après chaque fragment n'est pas récupérée sans fin", async () => {
    await mounted();
    for (let cycle = 0; cycle < 10; cycle++) {
      emit("hlsFragBuffered");
      fatal("mediaError");
    }
    expect(fake.recoverMediaError.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

/** L'élément tel que hls.js le laisse : en lecture à `at`, ou remis à zéro par un détachement (`null`). */
function elementAt(at: number | null) {
  const video = document.querySelector("video")!;
  Object.defineProperty(video, "readyState", { configurable: true, get: () => (at === null ? 0 : 4) });
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => at ?? 0, set: () => {} });
}
/** Ce qu'hls.js 1.7 pose quand il a appelé `recoverMediaError()` lui-même (ResetMediaSource | SwitchToSDR). */
const RESET_BY_HLS = { action: 5, flags: 16 | 8 };
const requiresReset = (isFatal: boolean) =>
  emit("hlsError", { fatal: isFatal, type: "mediaError", details: "mediaSourceRequiresReset", errorAction: RESET_BY_HLS });

describe("hls.js 1.7 — une seule récupération par incident, à la bonne position", () => {
  beforeEach(() => {
    // Ouvert loin du début, comme une séance reprise d'un préchauffage (§78, `startPosition`).
    playback.session = { itemId: "film", openId: 1, resumeAt: 600, title: "Film" };
  });

  it("MEDIA_SOURCE_REQUIRES_RESET fatale déjà récupérée par hls.js : pas de second recoverMediaError, chargement relancé où l'élément en était", async () => {
    await mounted();
    elementAt(1500);
    // hls.js détache lui-même (sa récupération), l'élément retombe à zéro, puis la fatale nous arrive.
    emit("hlsMediaDetaching");
    elementAt(null);
    requiresReset(true);
    expect(fake.recoverMediaError).not.toHaveBeenCalled();
    expect(fake.startLoad).toHaveBeenCalledTimes(1);
    expect(fake.startLoad).toHaveBeenCalledWith(1500);
  });

  it("erreur média fatale ordinaire : notre récupération, puis le chargement relancé à la position courante — pas au point d'ouverture", async () => {
    await mounted();
    elementAt(1500);
    fatal("mediaError");
    expect(fake.recoverMediaError).toHaveBeenCalledTimes(1);
    expect(fake.startLoad).toHaveBeenCalledWith(1500);
    expect(fake.startLoad).not.toHaveBeenCalledWith(600);
  });

  it("erreur média fatale avant la première image : relancée au point de reprise", async () => {
    await mounted();
    elementAt(null);
    fatal("mediaError");
    expect(fake.recoverMediaError).toHaveBeenCalledTimes(1);
    // Le point de reprise tel que la séance l'a ouvert (reculé de quelques secondes à la reprise,
    // `resumeRewind`) — jamais le début.
    const at = fake.startLoad.mock.calls[0]?.[0] as number;
    expect(at).toBeGreaterThan(580);
    expect(at).toBeLessThanOrEqual(600);
  });

  it("erreur réseau fatale : la relance repart de la position courante", async () => {
    await mounted();
    elementAt(1500);
    vi.useFakeTimers();
    fatal("networkError");
    act(() => void vi.advanceTimersByTime(1000));
    expect(fake.startLoad).toHaveBeenCalledTimes(1);
    expect(fake.startLoad).toHaveBeenCalledWith(1500);
  });

  it("hls.js 1.7 réessaie lui-même une requête restée sans réponse : c'est une coupure, dite tout de suite — pas une expiration", async () => {
    await mounted();
    emit("hlsError", { fatal: false, type: "networkError", details: "fragLoadError", response: { code: 0, text: "" } });
    await waitFor(() => expect(document.body.textContent).toContain("player.slowLink.unstable"));
    emit("hlsFragBuffered");
    await waitFor(() => expect(document.body.textContent).not.toContain("player.slowLink.unstable"));
    // Une expiration (le lien est lent, il livre) n'est pas une coupure.
    emit("hlsError", { fatal: false, type: "networkError", details: "fragLoadTimeOut" });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).not.toContain("player.slowLink.unstable");
  });

  it("les remises à zéro non fatales d'hls.js comptent au budget : trois, puis une fatale = la marche H.264, élément détaché", async () => {
    await mounted();
    elementAt(1500);
    for (let i = 0; i < 3; i++) requiresReset(false);
    expect(fake.recoverMediaError).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("player.playbackInterrupted");
    requiresReset(true);
    expect(fake.recoverMediaError).not.toHaveBeenCalled();
    expect(fake.startLoad).not.toHaveBeenCalled();
    // Sans le détachement, la MediaSource neuve d'hls.js rechargerait sous la relance (`autoStartLoad`).
    expect(fake.detachMedia).toHaveBeenCalledTimes(1);
    // À la position où l'élément en était.
    await waitFor(() => expect(negotiations().at(-1)).toMatchObject({ videoH264Only: true, startTicks: 1500 * 10_000_000 }), { timeout: 3000 });
  });
});

/**
 * La borne d'une coupure (`NETWORK_OUTAGE_GIVE_UP_MS`, décision de Louis du 15/10/2026) : l'écran
 * final ~48 s après le premier signe, comme avec hls.js 1.5.17. hls.js 1.7, hors ligne, attend le
 * réseau sans fin et ne déclare aucune fatale — l'écran ne venait plus (mesuré : > 5 min 30).
 */
describe("hls.js 1.7 — une coupure a sa borne : l'écran final à 48 s", () => {
  const sansReponse = () => emit("hlsError", { fatal: false, type: "networkError", details: "fragLoadError", response: { code: 0, text: "" } });

  it("la politique : 48 s, juste au-dessus des six relances (45 s)", async () => {
    const { NETWORK_OUTAGE_GIVE_UP_MS } = await import("@/components/PlayerHost");
    expect(NETWORK_OUTAGE_GIVE_UP_MS).toBe(48_000);
    expect(NETWORK_OUTAGE_GIVE_UP_MS).toBeGreaterThan(1000 + 2000 + 4000 + 8000 + 15000 + 15000);
  });

  it("hors ligne (hls.js attend sans fin) : « coupure » tout de suite, puis l'écran final à 48 s, hls.js arrêté et détaché", async () => {
    await mounted();
    vi.useFakeTimers();
    sansReponse();
    expect(document.body.textContent).toContain("player.slowLink.unstable");
    act(() => void vi.advanceTimersByTime(47_999));
    expect(document.body.textContent).not.toContain("player.playbackInterruptedCheckConnection");
    // hls.js ne dit plus rien : il attend le réseau. La borne seule décide.
    act(() => void vi.advanceTimersByTime(1));
    expect(document.body.textContent).toContain("player.playbackInterruptedCheckConnection");
    expect(fake.stopLoad).toHaveBeenCalled();
    expect(fake.detachMedia).toHaveBeenCalledTimes(1);
  });

  it("une coupure courte reprend seule : un fragment accepté avant l'échéance efface la borne", async () => {
    await mounted();
    vi.useFakeTimers();
    sansReponse();
    act(() => void vi.advanceTimersByTime(30_000));
    emit("hlsFragBuffered");
    act(() => void vi.advanceTimersByTime(60_000));
    expect(document.body.textContent).not.toContain("player.playbackInterrupted");
    expect(fake.detachMedia).not.toHaveBeenCalled();
    // Une seconde coupure a sa propre borne, entière.
    sansReponse();
    act(() => void vi.advanceTimersByTime(47_000));
    expect(document.body.textContent).not.toContain("player.playbackInterrupted");
    act(() => void vi.advanceTimersByTime(1_000));
    expect(document.body.textContent).toContain("player.playbackInterruptedCheckConnection");
  });

  it("des fatales réseau : la borne compte depuis la première, et les relances restent les nôtres", async () => {
    await mounted();
    vi.useFakeTimers();
    fatal("networkError");
    act(() => void vi.advanceTimersByTime(1000));
    expect(fake.startLoad).toHaveBeenCalledTimes(1);
    fatal("networkError");
    act(() => void vi.advanceTimersByTime(46_999));
    expect(document.body.textContent).not.toContain("player.playbackInterruptedCheckConnection");
    act(() => void vi.advanceTimersByTime(1));
    expect(document.body.textContent).toContain("player.playbackInterruptedCheckConnection");
  });

  it("« Réessayer » repart de la position où l'image s'est figée", async () => {
    await mounted();
    elementAt(1500);
    act(() => void document.querySelector("video")!.dispatchEvent(new Event("timeupdate")));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sansReponse();
    act(() => void vi.advanceTimersByTime(48_000));
    expect(document.body.textContent).toContain("player.playbackInterruptedCheckConnection");
    // Détaché, l'élément retombe à zéro : la position retenue n'en bouge pas.
    elementAt(null);
    const retry = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "common.retry")!;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/jellyfin/playback/start")).toHaveLength(2)
    );
    const second = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/jellyfin/playback/start")[1];
    expect(JSON.parse((second[1] as RequestInit).body as string).startTicks).toBe(1500 * 10_000_000);
  });
});

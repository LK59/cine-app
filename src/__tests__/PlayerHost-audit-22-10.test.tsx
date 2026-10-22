// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

// Trois écarts du lecteur serveur relevés par l'audit du 22/10/2026, chacun prouvé par un test qui
// échouait avant son correctif : le saut de reprise d'une renégociation hls.js compté comme un saut du
// spectateur, le logo du titre jamais transmis aux commandes, et le changement de piste WebKit qui
// rechargeait la page même sans avoir pu écrire son intention. Harnais de PlayerHost-hls-recovery.

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
/** Ce que les commandes ont reçu au dernier rendu. */
const controls = vi.hoisted(() => ({ logoUrl: undefined as string | null | undefined }));
vi.mock("@/components/PlayerControls", () => ({
  VOLUME_STORAGE_KEY: "volume",
  PlayerControls: (props: { onClose: () => void; onChangeAudio: (id: number) => void; logoUrl?: string | null }) => {
    controls.logoUrl = props.logoUrl;
    return (
      <div data-testid="commandes">
        <button onClick={props.onClose}>fermer</button>
        <button onClick={() => props.onChangeAudio(2)}>piste</button>
      </div>
    );
  },
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
const SERVEUR = vi.hoisted(() => ["film", "ep-1", "ep-2"]);
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: SERVEUR, negotiating: false, reason: null, takeover: null, stepAside: vi.fn(), stepBack: vi.fn(), returning: null }),
}));
const reportPlayback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...a: unknown[]) => reportPlayback(...a) }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
/** hls.js (Chrome, Firefox, Edge, Android) par défaut ; WebKit pour le changement de piste par rechargement. */
const engine = vi.hoisted(() => ({ nativeHls: false }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => engine.nativeHls }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: async () => {}, reportNow: () => {}, resume: () => {} }),
  stopOrphanSession: async () => {},
}));

type Listener = (event: string, data: Record<string, unknown>) => void;
vi.mock("hls.js", () => {
  class Hls {
    static isSupported = () => true;
    static Events = { FRAG_BUFFERED: "hlsFragBuffered", ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed", LEVEL_LOADED: "hlsLevelLoaded", MEDIA_DETACHING: "hlsMediaDetaching" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" };
    bandwidthEstimate = 0;
    audioTracks = [];
    on(_event: string, _cb: Listener) {}
    off() {}
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    stopLoad() {}
    detachMedia() {}
    recoverMediaError() {}
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
  audioTracks: [{ index: 1, language: "fre", displayTitle: "fr" }, { index: 2, language: "eng", displayTitle: "en" }],
  subtitleTracks: [],
  title: "Film",
};
let negociations: Record<string, unknown>[] = [];
const video = () => document.querySelector("video")!;
const fire = (name: string) => act(() => void video().dispatchEvent(new Event(name)));

async function nextNegotiation(count: number) {
  await waitFor(() => expect(negociations.length).toBe(count), { timeout: 6000 });
  await act(async () => {});
}

/** Ce que fait l'élément d'une négociation à son image : chargé, saut de reprise, image. */
function loadAndResume() {
  fire("loadeddata");
  fire("seeking");
  fire("seeked");
  fire("playing");
}

async function stopLine(getByText: (t: string) => HTMLElement): Promise<Record<string, unknown>> {
  act(() => void getByText("fermer").click());
  await waitFor(() => expect(reportPlayback.mock.calls.some(([k]) => k === "stop")).toBe(true));
  return reportPlayback.mock.calls.filter(([k]) => k === "stop").map(([, f]) => f as Record<string, unknown>)[0];
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  negociations = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === "/api/jellyfin/playback/start") {
        negociations.push(JSON.parse(init?.body ?? "{}"));
        return { ok: true, status: 200, json: async () => reponse };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
  playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film" };
  engine.nativeHls = false;
  controls.logoUrl = undefined;
  reportPlayback.mockClear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hls.js : le saut de reprise d'une renégociation n'est pas un saut du spectateur", () => {
  // Une renégociation en plein film (changement de piste en place, « Réessayer », marche de
  // l'échelle, bascule allégée) garde l'effet du décompte sur hls.js — l'élément n'est pas remonté —
  // et son saut de reprise passait pour un geste : `seeks: 1` au bilan sans que le spectateur ait
  // touché à rien, et `runner.seekStarted()` (§78) armé sur un faux saut.
  it("changement de piste en place : aucun saut au bilan", { timeout: 20_000 }, async () => {
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    loadAndResume();
    act(() => void getByText("piste").click());
    await nextNegotiation(2);
    loadAndResume();
    const stop = await stopLine(getByText);
    expect(stop.restartWhy).toBe("audio×1");
    expect(stop.seeks ?? 0).toBe(0);
  });

  it("un vrai saut après la reprise compte toujours", { timeout: 20_000 }, async () => {
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    loadAndResume();
    act(() => void getByText("piste").click());
    await nextNegotiation(2);
    loadAndResume();
    // Le spectateur, ensuite.
    fire("seeking");
    fire("seeked");
    fire("playing");
    const stop = await stopLine(getByText);
    expect(stop.seeks).toBe(1);
  });
});

describe("le logo du titre", () => {
  // Seul l'hôte natif le passait (d5652ddd, 09/10/2026) : environ une ouverture sur six montrait le
  // titre écrit, et le lecteur changeait d'apparence en plein film en passant au serveur.
  it("les commandes du lecteur serveur reçoivent celui de l'ouverture", async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film", introArt: { name: "Film", backdropUrl: null, logoUrl: "/logo-film.png" } };
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(controls.logoUrl).toBe("/logo-film.png");
  });

  it("sans visuel d'ouverture (page rechargée), aucun logo : le titre écrit", async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(controls.logoUrl ?? null).toBeNull();
  });
});

describe("WebKit : changement de piste sans intention écrite", () => {
  // La page se rechargeait même quand `sessionStorage` refusait l'intention : elle revenait sans
  // séance et le film se fermait. Le rechargement n'a lieu que si l'intention est écrite ; sinon,
  // le changement en place (qui échouera sans doute et montrera « Réessayer »).
  it("l'écriture refusée : pas de coupure, la renégociation en place", { timeout: 20_000 }, async () => {
    engine.nativeHls = true;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === "reload-intent") throw new DOMException("quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    });
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    fire("loadeddata");
    act(() => void getByText("piste").click());
    await nextNegotiation(2);
    expect(negociations[1].audioStreamIndex).toBe(2);
  });

  it("l'écriture acceptée : l'intention est là et rien ne se renégocie dans la page", { timeout: 20_000 }, async () => {
    engine.nativeHls = true;
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    fire("loadeddata");
    act(() => void getByText("piste").click());
    expect(JSON.parse(sessionStorage.getItem("reload-intent") ?? "null")).toMatchObject({ itemId: "film", audioStreamIndex: 2, server: true });
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(negociations).toHaveLength(1);
  });
});

describe("la reprise après une longue pause (22/10/2026)", () => {
  // Le natif recule de cinq secondes après plus de dix minutes de pause ; le lecteur serveur repartait
  // pile où il s'était arrêté. Même règle désormais (`pauseRewindTarget`).
  function element(position: number) {
    const el = video();
    let at = position;
    Object.defineProperty(el, "readyState", { configurable: true, get: () => 4 });
    Object.defineProperty(el, "duration", { configurable: true, get: () => 5400 });
    Object.defineProperty(el, "currentTime", { configurable: true, get: () => at, set: (v: number) => void (at = v) });
    return () => at;
  }

  it("recule de cinq secondes au-delà de dix minutes", async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    loadAndResume();
    const position = element(1000);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fire("pause");
    now.mockReturnValue(1_000_000 + 11 * 60_000);
    fire("play");
    expect(position()).toBe(995);
  });

  it("ne bouge pas après une courte pause", async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    loadAndResume();
    const position = element(1000);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fire("pause");
    now.mockReturnValue(1_000_000 + 9 * 60_000);
    fire("play");
    expect(position()).toBe(1000);
  });
});


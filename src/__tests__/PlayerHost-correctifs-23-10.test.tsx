// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

// Les dérives du lecteur serveur relevées par l'audit des fusions du 23/10/2026 (DECISIONS.md §115),
// chacune prouvée par un test qui échouait avant son correctif. Harnais de PlayerHost-audit-22-10,
// avec la position que l'hôte donne au rapport à Jellyfin (`usePlaybackSession`) retenue.

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
  PlayerControls: (props: { onClose: () => void; onChangeAudio: (id: number) => void; onAdvance?: () => void; logoUrl?: string | null }) => {
    controls.logoUrl = props.logoUrl;
    return (
      <div data-testid="commandes">
        <button onClick={props.onClose}>fermer</button>
        <button onClick={() => props.onChangeAudio(2)}>piste</button>
        {props.onAdvance && <button onClick={props.onAdvance}>suivant</button>}
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
/** La position que l'hôte donne au rapport à Jellyfin (battements, arrêt). */
const jellyfin = vi.hoisted(() => ({ position: null as null | (() => number) }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: (position: () => number) => {
    jellyfin.position = position;
    return { stop: async () => {}, reportNow: () => {}, resume: () => {} };
  },
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
  jellyfin.position = null;
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** L'élément sous la main du test : image, position, saut en cours. */
function element(position: number) {
  const el = video();
  const state = { at: position, ready: 4, seeking: false };
  Object.defineProperty(el, "readyState", { configurable: true, get: () => state.ready });
  Object.defineProperty(el, "duration", { configurable: true, get: () => 5400 });
  Object.defineProperty(el, "seeking", { configurable: true, get: () => state.seeking });
  Object.defineProperty(el, "currentTime", { configurable: true, get: () => state.at, set: (v: number) => void (state.at = v) });
  return state;
}

describe("fermer pendant qu'un saut charge (F1-4)", () => {
  // Le natif donne la cible d'un saut en cours depuis le 22/09/2026 (`intendedPosition`) ; le serveur
  // donnait `lastKnownTime`, que `timeupdate` ne bouge plus tant que l'élément n'a pas d'image : la
  // position d'avant le saut partait au journal et à Jellyfin, et « Reprendre » y revenait.
  it("la ligne stop et Jellyfin reçoivent la cible du saut", { timeout: 20_000 }, async () => {
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    loadAndResume();
    const el = element(1000);
    fire("timeupdate");
    // Le spectateur saute à 2000 s ; l'élément n'a pas encore d'image là-bas.
    el.ready = 1;
    el.seeking = true;
    el.at = 2000;
    fire("seeking");
    fire("timeupdate");
    expect(jellyfin.position?.()).toBe(2000);
    const stop = await stopLine(getByText);
    expect(stop.at).toBe(2000);
  });

  it("hors d'un saut, la position connue", { timeout: 20_000 }, async () => {
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    loadAndResume();
    element(1000);
    fire("timeupdate");
    expect(jellyfin.position?.()).toBe(1000);
    const stop = await stopLine(getByText);
    expect(stop.at).toBe(1000);
  });
});

describe("l'épisode enchaîné en place repart sans les mesures du précédent (F1-8)", () => {
  // `switchGapMs` (bascule allégée → première image) et `reloadGapMs` (rechargement direct → première
  // image) n'étaient pas remis à zéro avec le reste de la séance par titre : le `stop` de l'épisode
  // suivant, enchaîné sans démonter le lecteur, portait ceux de l'épisode d'avant.
  it("le stop de l'épisode 2 ne porte ni switchGapMs ni reloadGapMs de l'épisode 1", { timeout: 20_000 }, async () => {
    const now = Date.now();
    playback.session = {
      itemId: "ep-1",
      openId: 1,
      resumeAt: 600,
      title: "Épisode 1",
      reloadCarry: { switchedAt: now - 500, direct: { decidedAt: now - 800, opening: false } },
      getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }),
    };
    const { getByText, rerender } = render(<PlayerHost />);
    await nextNegotiation(1);
    loadAndResume();
    act(() => void getByText("suivant").click());
    playback.session = { itemId: "ep-2", openId: 1, resumeAt: 0, title: "Épisode 2" };
    rerender(<PlayerHost />);
    await nextNegotiation(2);
    loadAndResume();
    act(() => void getByText("fermer").click());
    await waitFor(() => expect(reportPlayback.mock.calls.filter(([k]) => k === "stop")).toHaveLength(2));
    const [premier, second] = reportPlayback.mock.calls.filter(([k]) => k === "stop").map(([, f]) => f as Record<string, unknown>);
    expect([premier.itemId, typeof premier.switchGapMs, typeof premier.reloadGapMs]).toEqual(["ep-1", "number", "number"]);
    expect([second.itemId, second.switchGapMs, second.reloadGapMs]).toEqual(["ep-2", undefined, undefined]);
  });
});

// @vitest-environment jsdom
/**
 * Empreinte de comportement — le lecteur serveur (`PlayerHost`) avec ses VRAIES commandes
 * (`PlayerControls`), la vraie séance Jellyfin (`usePlaybackSession`), le vrai journal
 * (`reportPlayback`) et le vrai bilan gardé (`unsentStop`).
 *
 * Simulés : hls.js (ses appels notés), le moteur (HLS natif de WebKit ou hls.js, par scénario), le
 * fournisseur de lecture, le relais du lecteur natif (`useStableFallback`), le rechargement de page.
 * Voir README.md de ce dossier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, screen } from "@testing-library/react";
import { installRecorder, type Recorder } from "./recorder";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/useWakeLock", () => ({ useWakeLock: () => {} }));

const fil = vi.hoisted(() => ({ rec: null as null | { entries: unknown[][] } }));
const note = (...entry: unknown[]) => void fil.rec?.entries.push(entry);

vi.mock("@/lib/playerBench/bridge", () => ({ publishHandedOver: () => {} }));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));
vi.mock("@/components/PlaybackInfoPanel", () => ({ PlaybackInfoPanel: () => null }));
vi.mock("@/components/ExperimentalPlayerHost", () => ({ ExperimentalPlayerHost: () => <div data-testid="natif" /> }));

const playback = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  mode: "full" as "full" | "mini" | "closed",
}));
vi.mock("@/components/PlaybackProvider", () => ({
  usePlayback: () => ({
    ...playback,
    close: (...args: unknown[]) => note("playback", "close", ...args),
    advance: (next: { itemId: string; title?: string; resumeAt?: number }) => note("playback", "advance", { itemId: next.itemId, title: next.title, resumeAt: next.resumeAt }),
    minimize: () => note("playback", "minimize"),
    expand: () => note("playback", "expand"),
  }),
  PLAYER_RELOAD_INTENT_KEY: "cine:player-reload-intent",
}));
vi.mock("@/lib/useAccountPreferences", () => ({ useAccountPreferencesLoader: () => {} }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));

/** Le relais du lecteur natif : les titres qu'il a passés, et ce qu'il porte (position, diffusion…). */
const relais = vi.hoisted(() => ({ takeover: null as unknown }));
const SERVEUR = vi.hoisted(() => ["film", "ep-1", "ep-2", "ep-3"]);
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({
    handedOver: SERVEUR,
    negotiating: false,
    reason: null,
    takeover: relais.takeover,
    stepAside: (...args: unknown[]) => note("stepAside", ...args),
    stepBack: (...args: unknown[]) => note("stepBack", ...args),
    returning: null,
  }),
}));

const data = vi.hoisted(() => ({ item: undefined as unknown, episodes: undefined as unknown }));
vi.mock("swr", async (original) => {
  const real = await original<typeof import("swr")>();
  return {
    ...real,
    default: (key: unknown) => {
      if (typeof key === "string" && key.endsWith("/episodes")) return { data: data.episodes, error: undefined, mutate: async () => {} };
      if (typeof key === "string" && key.startsWith("/api/player/item/")) return { data: data.item, error: undefined, mutate: async () => {} };
      return { data: undefined, error: undefined, mutate: async () => {} };
    },
  };
});
vi.mock("@/lib/swr", async (original) => ({
  ...(await original<typeof import("@/lib/swr")>()),
  refreshAfterPlayback: async (itemId: unknown) => note("refreshAfterPlayback", itemId),
}));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
/** WebKit (HLS natif) ou un autre moteur (hls.js), par scénario. */
const engine = vi.hoisted(() => ({ nativeHls: true }));
vi.mock("@/lib/webkitEngine", async (original) => ({
  ...(await original<typeof import("@/lib/webkitEngine")>()),
  playsHlsNatively: () => engine.nativeHls,
}));
vi.mock("@/lib/serverReload", async (original) => ({
  ...(await original<typeof import("@/lib/serverReload")>()),
  reloadPage: () => note("reloadPage"),
}));

/** hls.js simulé : chaque appel noté au fil, ses écouteurs gardés pour que le scénario émette. */
type Listener = (event: string, data: Record<string, unknown>) => void;
const hlsFake = vi.hoisted(() => ({
  listeners: new Map<string, ((event: string, data: Record<string, unknown>) => void)[]>(),
  count: 0,
  config: null as null | Record<string, unknown>,
}));
vi.mock("hls.js", () => {
  class Hls {
    static isSupported = () => true;
    static Events = {
      FRAG_BUFFERED: "hlsFragBuffered",
      ERROR: "hlsError",
      MANIFEST_PARSED: "hlsManifestParsed",
      LEVEL_LOADED: "hlsLevelLoaded",
      MANIFEST_LOADED: "hlsManifestLoaded",
      FRAG_LOADING: "hlsFragLoading",
      FRAG_LOADED: "hlsFragLoaded",
      MEDIA_DETACHING: "hlsMediaDetaching",
    };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" };
    bandwidthEstimate = 0;
    audioTracks = [];
    id: number;
    constructor(config: Record<string, unknown>) {
      hlsFake.count += 1;
      this.id = hlsFake.count;
      const simple: Record<string, unknown> = {};
      for (const key of Object.keys(config ?? {}).sort()) {
        const v = config[key];
        if (v === null || ["string", "number", "boolean"].includes(typeof v)) simple[key] = v;
      }
      note("hls", this.id, "new", simple);
      hlsFake.config = config;
      hlsFake.listeners = new Map();
    }
    on(event: string, cb: Listener) {
      hlsFake.listeners.set(event, [...(hlsFake.listeners.get(event) ?? []), cb]);
    }
    off() {}
    loadSource(url: string) {
      note("hls", this.id, "loadSource", url);
    }
    attachMedia() {
      note("hls", this.id, "attachMedia");
    }
    startLoad(...args: unknown[]) {
      note("hls", this.id, "startLoad", ...args);
    }
    stopLoad() {
      note("hls", this.id, "stopLoad");
    }
    detachMedia() {
      note("hls", this.id, "detachMedia");
    }
    recoverMediaError() {
      note("hls", this.id, "recoverMediaError");
    }
    destroy() {
      note("hls", this.id, "destroy");
    }
  }
  return { default: Hls };
});

import { PlayerHost } from "@/components/PlayerHost";
import { noteWatching } from "@/lib/resumeRewind";
import { resetIntroClocks } from "@/lib/playbackIntro";
import { forgetLighterCarry, writePlaybackQuality } from "@/lib/playbackQuality";
import { forgetPrewarm } from "@/lib/lighterPrewarm";
import { resetNetworkTrouble } from "@/lib/networkTrouble";
import { UPSTREAM_UNREACHABLE } from "@/lib/http";

/** Le générique de fin que la négociation annonce, par scénario. */
let creditsStart: number | null = null;
const reponse = () => ({
  creditsStart,
  playSessionId: "seance-jf",
  sourceBitrateBps: 16_000_000,
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8?DeviceId=appareil-1&MediaSourceId=source&PlaySessionId=seance-jf",
  audioTracks: [
    { index: 1, language: "fre", title: null, codec: "eac3", channels: 6, profile: null, isDefault: true },
    { index: 2, language: "eng", title: null, codec: "aac", channels: 2, profile: null, isDefault: false },
  ],
  subtitleTracks: [
    { index: 3, url: "/api/jellyfin/stream/film/subs/3.vtt", language: "fre", title: null, isDefault: false, isForced: false },
    { index: 4, url: "/api/jellyfin/stream/film/subs/4.vtt", language: "eng", title: null, isDefault: false, isForced: false },
  ],
  title: "Film",
  playbackInfo: {
    playMethod: "DirectStream",
    transcodeReasons: [],
    container: "ts",
    requestedVideoCodecs: [],
    video: { codec: "h264", profile: null, width: 1920, height: 1080, bitDepth: 8, frameRate: 24, bitRate: 3_500_000 },
    audio: { codec: "aac", channels: 2, bitRate: 400_000, language: "fre" },
  },
});

let rec: Recorder;
/** Ce que la négociation répond : la réponse ordinaire, ou un refus nommé. */
let refusal: null | { status: number; body: Record<string, unknown> } = null;

function responder(url: string): unknown {
  if (url === "/api/jellyfin/playback/start") {
    if (refusal) {
      const r = refusal;
      return { ok: false, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }
    return { ok: true, status: 200, json: async () => reponse() };
  }
  if (url.startsWith("/api/jellyfin/playback-state/")) return { ok: true, status: 200, json: async () => ({ resumeSeconds: 300, preferences: null }) };
  if (url.includes("master.m3u8")) return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"\nmain.m3u8?x=1\n' };
  if (url.includes("main.m3u8")) return { ok: true, status: 200, text: async () => "#EXTM3U\n#EXTINF:3.003,\nhls1/main/0.ts\n#EXTINF:3.003,\nhls1/main/1.ts\n#EXT-X-ENDLIST\n" };
  if (url.includes("/hls1/main/")) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1000) };
  if (url.startsWith("/api/jellyfin/chapters")) return { ok: true, status: 200, json: async () => [] };
  if (url.startsWith("/api/jellyfin/trickplay/info")) return { ok: false, status: 404, json: async () => null };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
}

type SessionOver = Partial<{ itemId: string; resumeAt: number | null; episodes: boolean; title: string }>;
function setSession(over: SessionOver = {}) {
  const itemId = over.itemId ?? "film";
  playback.session = {
    itemId,
    title: over.title ?? "Film",
    openId: 1,
    ...(over.resumeAt === null ? {} : { resumeAt: over.resumeAt ?? 120 }),
    ...(over.episodes ? { seriesId: "serie-1", getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }) } : {}),
  };
}

const video = () => document.querySelector("video") as HTMLVideoElement;
async function media(type: string, at?: number) {
  if (at !== undefined) rec.media(video(), { currentTime: at });
  await act(async () => void fireEvent(video(), new Event(type)));
}
function emit(event: string, payload: Record<string, unknown> = {}) {
  act(() => {
    for (const cb of hlsFake.listeners.get(event) ?? []) cb(event, payload);
  });
}
/** La première image, telle que l'élément l'annonce (et hls.js son premier fragment). */
async function firstPicture(at: number) {
  rec.media(video(), { duration: 3600, readyState: 4 });
  if (!engine.nativeHls) {
    emit("hlsManifestParsed", {});
    emit("hlsFragBuffered", {});
  }
  for (const type of ["loadedmetadata", "durationchange", "loadeddata", "canplay"]) await media(type, at);
  // `autoPlay` : le navigateur lance l'élément de lui-même dès qu'il peut (hls.js).
  if (video().autoplay && video().paused) {
    rec.media(video(), { paused: false });
    await media("play");
  }
  if (!video().paused) await media("playing", at);
  await media("timeupdate", at);
  await rec.flush();
}
async function play(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    if (!video().paused) rec.media(video(), { currentTime: video().currentTime + 1 });
    await media("timeupdate");
  }
}
async function seekArrives(ms = 300) {
  rec.media(video(), { seeking: true });
  await media("seeking");
  await rec.advance(ms);
  rec.media(video(), { seeking: false });
  await media("seeked");
  await media("timeupdate");
}
async function key(k: string, code = k) {
  await act(async () => void fireEvent.keyDown(window, { key: k, code }));
  await act(async () => void fireEvent.keyUp(window, { key: k, code }));
  await rec.flush(4);
}
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  Object.defineProperty(document, "hidden", { value: state === "hidden", configurable: true });
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
}
async function click(el: Element) {
  await act(async () => void fireEvent.click(el));
  await rec.flush(4);
}
const byLabel = (label: string | RegExp) => screen.getAllByLabelText(label)[0];
const buttonsWith = (re: RegExp) => Array.from(document.querySelectorAll("button")).filter((b) => re.test((b.textContent ?? "").trim()));
async function pick(menu: string, entry: RegExp) {
  await click(byLabel(menu));
  rec.dom(`menu ${menu}`);
  const items = buttonsWith(entry);
  if (!items.length) throw new Error(`aucune entrée ${entry} dans le menu ${menu}`);
  rec.step(`choix ${(items[0].textContent ?? "").trim()}`);
  await click(items[0]);
}
const pagehide = (persisted: boolean) => act(() => void window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted })));
/** La route sans fil d'AirPlay, telle que Safari la dit à l'élément. */
const route = { wireless: false };
function setRoute(wireless: boolean) {
  route.wireless = wireless;
  act(() => void video().dispatchEvent(new Event("webkitcurrentplaybacktargetiswirelesschanged")));
}

async function openAndPlay(over: SessionOver = {}, at = 120) {
  setSession(over);
  const view = render(<PlayerHost />);
  rec.step("monté");
  await rec.flush(20);
  await rec.advance(0);
  rec.dom("ouverture");
  await firstPicture(at);
  rec.step("première image");
  rec.dom("première image");
  return view;
}
async function closeByCross() {
  rec.step("croix");
  await click(byLabel("common.close"));
  await rec.advance(1_000);
  rec.dom("fermé");
}
async function fingerprint(): Promise<void> {
  await rec.fingerprint("serveur");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetIntroClocks();
  forgetLighterCarry();
  forgetPrewarm();
  resetNetworkTrouble();
  rec = installRecorder({ seed: 11 });
  fil.rec = rec;
  noteWatching("film");
  noteWatching("ep-1");
  writePlaybackQuality("auto");
  rec.entries.length = 0;
  rec.respond(responder);
  refusal = null;
  creditsStart = null;
  relais.takeover = null;
  route.wireless = false;
  engine.nativeHls = true;
  hlsFake.listeners = new Map();
  hlsFake.count = 0;
  hlsFake.config = null;
  data.item = undefined;
  data.episodes = undefined;
  playback.mode = "full";
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  Object.defineProperty(HTMLMediaElement.prototype, "webkitCurrentPlaybackTargetIsWireless", { configurable: true, get: () => route.wireless });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});
afterEach(() => {
  rec.debug(`serveur-${(expect.getState().currentTestName ?? "x").replace(/[^\w]+/g, "-").slice(0, 80)}`);
  cleanup();
  fil.rec = null;
  rec.uninstall();
  delete (HTMLMediaElement.prototype as { webkitCurrentPlaybackTargetIsWireless?: boolean }).webkitCurrentPlaybackTargetIsWireless;
});

describe("empreinte — lecteur serveur : ouverture et fermeture (WebKit, HLS natif)", () => {
  it("reprise donnée par l'appelant, lecture, croix", async () => {
    await openAndPlay({ resumeAt: 120 });
    await play(30);
    await closeByCross();
    await fingerprint();
  });

  it("position demandée au serveur (reprise absente)", async () => {
    await openAndPlay({ resumeAt: null }, 300);
    await play(5);
    await closeByCross();
    await fingerprint();
  });

  it("depuis le début (reprise 0)", async () => {
    localStorage.removeItem("cine:last-watched");
    await openAndPlay({ resumeAt: 0 }, 0);
    await play(5);
    await closeByCross();
    await fingerprint();
  });

  it("pagehide non mis en cache, puis démontage", async () => {
    const { unmount } = await openAndPlay();
    await play(10);
    rec.step("pagehide");
    pagehide(false);
    await rec.flush();
    unmount();
    await rec.flush();
    await fingerprint();
  });

  it("pagehide mis en cache (bfcache), puis démontage", async () => {
    const { unmount } = await openAndPlay();
    await play(10);
    rec.step("pagehide bfcache");
    pagehide(true);
    await rec.advance(5_000);
    rec.step("démontage");
    unmount();
    await rec.flush();
    await fingerprint();
  });
});

describe("empreinte — lecteur serveur : sauts et pause", () => {
  it("sauts : clavier, bouton +10, en pause", async () => {
    await openAndPlay();
    await play(5);
    rec.step("→ au clavier");
    await key("ArrowRight");
    await seekArrives();
    await play(3);
    rec.step("bouton +10");
    const tens = buttonsWith(/^10$/);
    await click(tens[tens.length - 1]);
    await seekArrives(800);
    await play(2);
    rec.step("pause (espace)");
    await key(" ", "Space");
    rec.dom("en pause");
    rec.step("← en pause");
    await key("ArrowLeft");
    await seekArrives();
    rec.dom("saut en pause");
    await closeByCross();
    await fingerprint();
  });

  it("pause de plus de dix minutes, puis lecture", async () => {
    await openAndPlay({ resumeAt: 1200 }, 1200);
    await play(40);
    rec.step("pause");
    await click(byLabel("player.pause"));
    await rec.advance(11 * 60_000);
    rec.step("lecture");
    await click(byLabel("player.play"));
    await media("playing");
    await play(3);
    await closeByCross();
    await fingerprint();
  });
});

describe("empreinte — lecteur serveur : pistes", () => {
  it("WebKit : changer de piste audio écrit l'intention et recharge la page", async () => {
    await openAndPlay();
    await play(10);
    rec.step("audio → anglais");
    await pick("player.audio", /anglais/i);
    await rec.advance(1_000);
    await fingerprint();
  });

  it("hls.js : changer de piste audio renégocie dans la page", async () => {
    engine.nativeHls = false;
    await openAndPlay();
    await play(10);
    rec.step("audio → anglais");
    await pick("player.audio", /anglais/i);
    await rec.advance(1_000);
    await firstPicture(130);
    rec.dom("après changement");
    await play(2);
    await closeByCross();
    await fingerprint();
  });

  it("sous-titres : un, un autre, deux à la fois, aucun", async () => {
    await openAndPlay();
    await play(2);
    await pick("player.subtitles", /fran/i);
    await play(1);
    rec.dom("français");
    await pick("player.subtitles", /anglais/i);
    await play(1);
    rec.step("deux sous-titres");
    await click(byLabel("player.subtitles"));
    const dual = buttonsWith(/^player\.dualSubtitles\.title/);
    if (dual.length) {
      await click(dual[0]);
      const second = buttonsWith(/^player\.dualSubtitles\.second/);
      if (second.length) await click(second[0]);
      rec.dom("choix du second");
      const fr = buttonsWith(/fran/i);
      if (fr.length) await click(fr[fr.length - 1]);
    }
    await play(1);
    rec.dom("deux sous-titres");
    await pick("player.subtitles", /^player\.none/);
    await play(1);
    await closeByCross();
    await fingerprint();
  });
});

describe("empreinte — lecteur serveur : arrière-plan", () => {
  it("court aller-retour, puis longue absence", async () => {
    await openAndPlay();
    await play(10);
    rec.step("caché 3 s");
    setVisibility("hidden");
    await rec.advance(3_000);
    setVisibility("visible");
    await rec.advance(500);
    await play(2);
    rec.step("caché 10 min");
    setVisibility("hidden");
    await rec.advance(600_000);
    setVisibility("visible");
    await rec.advance(2_000);
    rec.dom("au retour");
    await closeByCross();
    await fingerprint();
  });
});

describe("empreinte — lecteur serveur : réseau (hls.js)", () => {
  it("erreur réseau fatale : relances espacées, fragment revenu, puis coupure jusqu'à l'abandon", async () => {
    engine.nativeHls = false;
    await openAndPlay();
    await play(5);
    rec.step("erreur réseau");
    emit("hlsError", { fatal: true, type: "networkError", details: "fragLoadError" });
    await rec.advance(1_500);
    emit("hlsError", { fatal: true, type: "networkError", details: "fragLoadError" });
    await rec.advance(3_000);
    rec.step("fragment revenu");
    emit("hlsFragBuffered", {});
    await play(2);
    rec.step("hors ligne");
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("offline")));
    emit("hlsError", { fatal: true, type: "networkError", details: "fragLoadError" });
    await rec.advance(30_000);
    rec.dom("coupure 30 s");
    await rec.advance(120_000);
    rec.dom("abandon");
    await fingerprint();
  });

  it("erreur média : recoverMediaError, puis l'écran d'erreur au bout du budget", async () => {
    engine.nativeHls = false;
    await openAndPlay();
    await play(5);
    for (let i = 0; i < 4; i++) {
      rec.step(`erreur média ${i + 1}`);
      emit("hlsError", { fatal: true, type: "mediaError", details: "bufferAppendError" });
      await rec.advance(1_000);
    }
    rec.dom("écran d'erreur");
    await fingerprint();
  });

  it("lien lent à l'ouverture : indice, préchauffage, bascule allégée", async () => {
    engine.nativeHls = false;
    setSession({ resumeAt: 0 });
    render(<PlayerHost />);
    await rec.flush(20);
    await rec.advance(0);
    for (let i = 0; i < 50 && !hlsFake.count; i++) await rec.flush(2);
    // La requête d'hls.js, mesurée par le lecteur (`xhrSetup`) : 40 ko/s pour 3,9 Mbit/s demandés.
    const xhr = new EventTarget() as EventTarget & { readyState: number };
    xhr.readyState = 0;
    const setup = hlsFake.config?.xhrSetup as ((x: XMLHttpRequest, url: string) => void) | undefined;
    setup?.(xhr as unknown as XMLHttpRequest, "/api/jellyfin/stream/film/segment0.ts");
    xhr.readyState = 2;
    xhr.dispatchEvent(new Event("readystatechange"));
    rec.step("lien lent");
    let loaded = 0;
    for (let t = 0; t < 12; t++) {
      await rec.advance(1_000);
      loaded += 40_000;
      xhr.dispatchEvent(Object.assign(new Event("progress"), { loaded }));
      if (t === 5 || t === 9) rec.dom(`à ${t + 1} s`);
    }
    await rec.advance(10_000);
    rec.dom("après 22 s");
    await fingerprint();
  });
});

describe("empreinte — lecteur serveur : diffusion", () => {
  it("relais pour diffuser : la route prise, puis perdue — la main rendue au natif", async () => {
    setSession();
    relais.takeover = { resumeAt: 120, owner: playback.session, cast: true };
    await openAndPlay();
    await play(3);
    rec.step("route sans fil");
    setRoute(true);
    await rec.advance(1_000);
    rec.dom("diffusion");
    rec.step("route perdue");
    setRoute(false);
    await rec.advance(1_000);
    await fingerprint();
  });
});

describe("empreinte — lecteur serveur : épisode suivant", () => {
  it("le bouton « épisode suivant »", async () => {
    await openAndPlay({ itemId: "ep-1", title: "Épisode 1", episodes: true });
    await play(5);
    rec.step("suivant");
    await click(byLabel("player.nextEpisode"));
    await rec.flush();
    await fingerprint();
  });

  it("la carte du générique, et son décompte", async () => {
    creditsStart = 3300;
    await openAndPlay({ itemId: "ep-1", title: "Épisode 1", episodes: true, resumeAt: 3290 }, 3290);
    await play(12);
    rec.dom("carte du générique");
    await play(12);
    await fingerprint();
  });

  it("un épisode choisi dans le menu « Épisodes »", async () => {
    const ep = (id: string, n: number) => ({
      jellyfinItemId: id,
      seasonNumber: 1,
      episodeNumber: n,
      title: `Épisode ${n}`,
      overview: null,
      thumbnailUrl: null,
      runtimeMinutes: 42,
      runtimeTicks: 42 * 60 * 10_000_000,
      watched: false,
      resumeTicks: n === 3 ? 600 * 10_000_000 : null,
    });
    data.item = { seriesId: "serie-1", download: null };
    data.episodes = { seasons: [{ seasonNumber: 1, episodes: [ep("ep-1", 1), ep("ep-2", 2), ep("ep-3", 3)] }], nextEpisode: null };
    await openAndPlay({ itemId: "ep-1", title: "Épisode 1", episodes: true });
    await play(3);
    rec.step("menu Épisodes");
    await pick("player.episodes.title", /Épisode 3/);
    await rec.flush();
    await fingerprint();
  });
});

describe("empreinte — lecteur serveur : écrans d'erreur", () => {
  it("serveur média injoignable (négociation refusée, code amont)", async () => {
    refusal = { status: 502, body: { code: UPSTREAM_UNREACHABLE, error: "jellyfin.local ne répond pas" } };
    setSession();
    render(<PlayerHost />);
    await rec.flush(20);
    await rec.advance(1_000);
    rec.dom("injoignable");
    await fingerprint();
  });

  it("session Jellyfin expirée : l'écran de reconnexion, « Quitter »", async () => {
    refusal = { status: 401, body: { code: "jellyfin_reauth_required" } };
    setSession();
    render(<PlayerHost />);
    await rec.flush(20);
    await rec.advance(1_000);
    rec.dom("reconnexion");
    await click(screen.getByText("player.quit"));
    await rec.flush();
    await fingerprint();
  });

  it("l'élément refuse la source (code 4) : l'échelle du son, marche après marche", async () => {
    await openAndPlay();
    for (let i = 0; i < 4; i++) {
      rec.step(`refus ${i + 1}`);
      Object.defineProperty(video(), "error", { configurable: true, value: { code: 4, message: "unsupported" } });
      await media("error");
      await rec.advance(6_000);
      await rec.flush(10);
    }
    rec.dom("au bout de l'échelle");
    await fingerprint();
  });
});

// @vitest-environment jsdom
/**
 * Empreinte de comportement — l'hôte du lecteur natif (`ExperimentalPlayerHost`) avec ses VRAIES
 * commandes (`PlayerControls`) et la vraie séance Jellyfin (`usePlaybackSession`).
 *
 * Chaque scénario joue un geste de spectateur de bout en bout et compare le fil complet de ce que le
 * lecteur a produit (journal, requêtes, stockage, ordres à l'élément, trace locale, résumé des
 * commandes) à une empreinte enregistrée. Seul ce qui est sous l'hôte est simulé : le pipeline
 * (`remuxPlayback`), la description du fichier (SWR), le fournisseur de lecture, le préchauffage de
 * la version allégée. Voir README.md de ce dossier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, screen } from "@testing-library/react";
import { installRecorder, type Recorder } from "./recorder";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));

/** Le fil partagé avec les doubles : la trace locale du lecteur y entre aussi, dans l'ordre. */
const fil = vi.hoisted(() => ({ rec: null as null | { entries: unknown[][] } }));
const note = (...entry: unknown[]) => void fil.rec?.entries.push(entry);

vi.mock("@/lib/webcodecs/trace", () => ({
  trace: (message: string) => note("trace", message),
  traceKeepAcrossReset: () => {},
  traceRecent: () => [],
}));
vi.mock("@/lib/webcodecs/pathSelector", () => ({ NATIVE_PATH: "raison du choix" }));
vi.mock("@/lib/webcodecs/capabilities", () => ({ probeCapabilities: async () => ({}), describeCapabilities: () => ({}) }));
vi.mock("@/components/ExperimentalPlayerReport", () => ({ ExperimentalPlayerReport: () => <div role="status" aria-label="rapport" /> }));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));
vi.mock("@/components/PlaybackProvider", () => ({
  usePlayback: () => ({
    close: (...args: unknown[]) => note("playback", "close", ...args),
    minimize: () => note("playback", "minimize"),
    expand: () => note("playback", "expand"),
    advance: (next: { itemId: string; title?: string; resumeAt?: number }) => note("playback", "advance", { itemId: next.itemId, title: next.title, resumeAt: next.resumeAt }),
    session: null,
  }),
  PLAYER_RELOAD_INTENT_KEY: "cine:player-reload-intent",
}));

type Info = Record<string, unknown>;
const data = vi.hoisted(() => ({ info: undefined as Record<string, unknown> | undefined, error: undefined as unknown, episodes: undefined as unknown, item: undefined as unknown }));
vi.mock("swr", () => ({
  default: (key: unknown) => {
    // La description du fichier : la clé de l'hôte est un tableau (adresse, ouverture, essai).
    if (Array.isArray(key)) return { data: data.info, error: data.error, mutate: async () => {} };
    if (typeof key === "string" && key.endsWith("/episodes")) return { data: data.episodes, error: undefined, mutate: async () => {} };
    if (typeof key === "string" && key.startsWith("/api/player/item/")) return { data: data.item, error: undefined, mutate: async () => {} };
    return { data: undefined, error: undefined, mutate: async () => {} };
  },
  mutate: async () => {},
  useSWRConfig: () => ({ mutate: async () => {} }),
}));
vi.mock("@/lib/swr", async (original) => ({
  ...(await original<typeof import("@/lib/swr")>()),
  refreshAfterPlayback: async (itemId: string) => note("refreshAfterPlayback", itemId),
}));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
vi.mock("@/lib/webcodecs/memoryReserve", () => ({
  reservePlanFacts: () => ({}),
  MemoryReserve: { start: () => (note("reserve", "start"), { stop: () => (note("reserve", "stop"), {}) }) },
}));
vi.mock("@/lib/resumeCache/keepOnStop", () => ({ keepOnStop: async () => (note("keepOnStop"), 0) }));

/** Le préchauffage de la version allégée (§78) : noté, et prêt quand le scénario le dit. */
const warm = vi.hoisted(() => ({ list: [] as { settle: (ok: boolean) => void }[] }));
vi.mock("@/lib/lighterPrewarm", async (original) => {
  const real = await original<typeof import("@/lib/lighterPrewarm")>();
  return {
    prewarmStatusOf: real.prewarmStatusOf,
    prewarmGone: real.prewarmGone,
    startPrewarm: (options: { itemId: string; step: { targetBps: number; tier: number }; startSeconds: number }) => {
      note("prewarm", "start", { itemId: options.itemId, step: options.step, startSeconds: options.startSeconds });
      let resolve: (ok: boolean) => void = () => {};
      const prewarm = { ...options, state: "running", startedAt: 0, readyAt: null as number | null, ready: new Promise<boolean>((r) => (resolve = r)) };
      warm.list.push({
        settle: (ok) => {
          prewarm.state = ok ? "ready" : "failed";
          prewarm.readyAt = ok ? 1500 : null;
          resolve(ok);
        },
      });
      return prewarm;
    },
    cancelPrewarm: (p?: { state: string } | null) => {
      note("prewarm", "cancel", p ? p.state : null);
      if (p) p.state = "cancelled";
    },
    prewarmFields: () => ({ mbps: 1.5 }),
  };
});

// --- le pipeline simulé ------------------------------------------------------------------------

type Callbacks = {
  onError: (message: string, kind?: "network" | "playback", facts?: Record<string, unknown>) => void;
  onWarning: (warning: { code: string; detail?: string }) => void;
  onStarting: (at: number | null) => void;
  onStall?: (facts: Record<string, unknown>) => void;
  startSeconds: number;
};
const pipe = vi.hoisted(() => ({ probes: [] as unknown[], next: null as null | ((options: Record<string, unknown>) => unknown) }));

function fakeRemux(over: Record<string, unknown> = {}) {
  const fake = {
    audioTracks: [
      { number: 1, codecId: "A_EAC3", language: "fre", name: null, isDefault: true, isForced: false, channels: 6 },
      { number: 2, codecId: "A_AAC", language: "eng", name: null, isDefault: false, isForced: false, channels: 2 },
    ],
    subtitleTracks: [
      { number: 5, codecId: "S_TEXT/UTF8", language: "fre", name: null, isDefault: false, isForced: false },
      { number: 6, codecId: "S_TEXT/UTF8", language: "eng", name: null, isDefault: false, isForced: false },
    ],
    currentAudioTrack: 1,
    canCarryAudio: () => true,
    requestAudioTrack: (id: number) => (note("remux", "requestAudioTrack", id), id === fake.currentAudioTrack ? null : "rebuild"),
    selectSubtitleTrack: (id: unknown) => note("remux", "selectSubtitleTrack", id),
    subtitleAt: (_at: number, track?: number) => (track === 6 ? "Line." : track === 5 ? "Réplique." : null),
    diagnostics: {},
    destroy: () => note("remux", "destroy"),
    lost: false,
    lossReport: () => ({ videoBuffered: "10.00–14.00" }),
    position: 0,
    ...over,
  };
  return fake;
}
/** Le pipeline ouvert en dernier : un scénario le déclare perdu, ou le fait échouer. */
let current: ReturnType<typeof fakeRemux>;

/** Les options simples passées au pipeline (les fonctions et objets de l'hôte omis). */
function primitives(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(options).sort()) {
    const v = options[key];
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[key] = v;
  }
  return out;
}
vi.mock("@/lib/webcodecs/remuxPlayback", () => ({
  probePlaybackPath: async (options: Record<string, unknown>) => {
    pipe.probes.push(options);
    note("probe", primitives(options));
    if (pipe.probes.length > 30) throw new Error("trop de sondes");
    return pipe.next!(options);
  },
}));

import { noteWatching } from "@/lib/resumeRewind";
import { resetIntroClocks } from "@/lib/playbackIntro";
import { meterOpeningRequest } from "@/lib/slowLink";
import { forgetLighterCarry, writePlaybackQuality } from "@/lib/playbackQuality";
import { resetNetworkTrouble } from "@/lib/networkTrouble";
import { withCode } from "@/lib/upstreamError";
import { UPSTREAM_UNREACHABLE } from "@/lib/http";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";

function info(over: Info = {}): Info {
  return {
    streamUrl: "/stream.mkv",
    container: "mkv",
    refusedReason: null,
    externalSubtitles: [],
    audio: [{ index: 1 }, { index: 2 }],
    video: { codec: "hevc", width: 1920, height: 1080, bitDepth: 10, isHdr: false, rangeType: "SDR" },
    introSkip: null,
    creditsStart: null,
    ...over,
  };
}

let rec: Recorder;
let viewerState: { resumeSeconds: number; preferences: unknown };
const probes = () => pipe.probes as Callbacks[];
const lastProbe = () => probes()[probes().length - 1];

function standardResponder(url: string): unknown {
  if (url.startsWith("/api/jellyfin/playback-state/")) return { ok: true, status: 200, json: async () => viewerState };
  if (url.startsWith("/api/jellyfin/chapters")) return { ok: true, status: 200, json: async () => [] };
  if (url.startsWith("/api/jellyfin/trickplay/info")) return { ok: false, status: 404, json: async () => null };
  if (url.startsWith("/api/jellyfin/stream/subtitle/")) return { ok: true, status: 200, text: async () => "WEBVTT\n\n00:02:00.000 --> 00:02:10.000\nRéplique du fichier.\n" };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
}

type SessionOver = Partial<{ itemId: string; resumeAt: number | null; episodes: boolean; title: string }>;
function session(over: SessionOver = {}) {
  const itemId = over.itemId ?? "film-1";
  return {
    itemId,
    title: over.title ?? "Un film",
    openId: 1,
    ...(over.resumeAt === null ? {} : { resumeAt: over.resumeAt ?? 120 }),
    ...(over.episodes ? { seriesId: "serie-1", getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }) } : {}),
  };
}
function mount(over: SessionOver = {}) {
  return render(
    <ExperimentalPlayerHost
      session={session(over) as never}
      mode="full"
      onFallback={(reason, takeover) => note("onFallback", reason, takeover ?? null)}
    />
  );
}

const video = () => document.querySelector("video") as HTMLVideoElement;
/** Un événement de l'élément, l'horloge posée avant comme le navigateur l'aurait fait. */
async function media(type: string, at?: number) {
  if (at !== undefined) rec.media(video(), { currentTime: at });
  await act(async () => void fireEvent(video(), new Event(type)));
}
/** La première image : métadonnées, données, lecture, comme Safari les enchaîne. */
async function firstPicture(at: number) {
  rec.media(video(), { duration: 3600, readyState: 4 });
  for (const type of ["loadedmetadata", "durationchange", "loadeddata", "canplay"]) await media(type, at);
  // `playing` seulement si l'hôte a lancé l'élément : une reconstruction en pause n'en a pas.
  if (!video().paused) await media("playing", at);
  await media("timeupdate", at);
  await rec.flush();
}
/** La lecture qui avance : une seconde de film par seconde d'horloge, `timeupdate` à chaque. */
async function play(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    if (rec.entries.length > 20000) throw new Error("fil trop long");
    if (!video().paused) rec.media(video(), { currentTime: video().currentTime + 1 });
    await media("timeupdate");
  }
}
/** Un saut tel que l'élément le vit : `seeking`, l'horloge à la cible, puis `seeked` après `ms`. */
async function seekArrives(ms = 300) {
  // La cible est celle que le lecteur a posée sur l'élément.
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
const byText = (text: string | RegExp) => screen.getAllByText(text)[0];
/** Ouvre un menu des commandes, puis choisit l'entrée dont le texte correspond. */
async function pick(menu: string, entry: RegExp) {
  await click(byLabel(menu));
  rec.dom(`menu ${menu}`);
  const items = Array.from(document.querySelectorAll("button, [role^=menuitem]")).filter((el) => entry.test((el.textContent ?? "").trim()));
  if (!items.length) throw new Error(`aucune entrée ${entry} dans le menu ${menu}`);
  rec.step(`choix ${(items[0].textContent ?? "").trim()}`);
  await click(items[0]);
}
const pagehide = (persisted: boolean) => act(() => void window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted })));

/** Ouvre et mène à la première image, à `at`. */
async function openAndPlay(over: SessionOver = {}, at = 120) {
  const view = mount(over);
  rec.step("monté");
  await rec.flush();
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
  await rec.fingerprint("natif");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetIntroClocks();
  forgetLighterCarry();
  resetNetworkTrouble();
  rec = installRecorder({ seed: 7 });
  fil.rec = rec;
  // Joué récemment sur cet appareil : pas de recul de 5 s, sauf scénario qui le dit.
  noteWatching("film-1");
  noteWatching("ep-1");
  writePlaybackQuality("auto");
  rec.entries.length = 0;
  pipe.probes = [];
  warm.list = [];
  data.info = info();
  data.error = undefined;
  data.episodes = undefined;
  data.item = undefined;
  viewerState = { resumeSeconds: 300, preferences: null };
  rec.respond(standardResponder);
  pipe.next = (options) => {
    current = fakeRemux(typeof options.audioTrackNumber === "number" ? { currentAudioTrack: options.audioTrackNumber } : {});
    const opened = current;
    return { path: "remux", start: async () => opened, discard: () => note("remux", "discard") };
  };
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});
afterEach(() => {
  rec.debug((expect.getState().currentTestName ?? "x").replace(/[^\w]+/g, "-").slice(0, 80));
  cleanup();
  fil.rec = null;
  rec.uninstall();
  delete (HTMLMediaElement.prototype as { webkitShowPlaybackTargetPicker?: unknown }).webkitShowPlaybackTargetPicker;
});

describe("empreinte — lecteur natif : ouverture et fermeture", () => {
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

  it("depuis le début (reprise 0), titre pas joué récemment sur l'appareil", async () => {
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

  it("pagehide mis en cache (bfcache), retour, puis démontage", async () => {
    const { unmount } = await openAndPlay();
    await play(10);
    rec.step("pagehide bfcache");
    pagehide(true);
    await rec.advance(5_000);
    rec.step("pageshow");
    act(() => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
    await play(3);
    rec.step("démontage");
    unmount();
    await rec.flush();
    await fingerprint();
  });
});

describe("empreinte — lecteur natif : sauts et pause", () => {
  it("sauts : clavier, bouton +10, deux à la suite (le premier remplacé), en pause", async () => {
    await openAndPlay();
    await play(5);
    rec.step("→ au clavier");
    await key("ArrowRight");
    await seekArrives();
    await play(3);
    rec.step("bouton +10");
    const tens = Array.from(document.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim() === "10");
    await click(tens[tens.length - 1]);
    await seekArrives(800);
    await play(2);
    rec.step("→ → sans attendre");
    await key("ArrowRight");
    rec.media(video(), { seeking: true });
    await media("seeking");
    await rec.advance(100);
    await key("ArrowRight");
    await seekArrives(400);
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
    await play(100);
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

describe("empreinte — lecteur natif : pistes", () => {
  it("changer de piste audio reconstruit le lecteur sur la piste choisie", async () => {
    await openAndPlay();
    await play(20);
    rec.step("audio → anglais");
    await pick("player.audio", /anglais/i);
    await rec.flush();
    await firstPicture(140);
    rec.dom("après changement");
    await play(3);
    await closeByCross();
    await fingerprint();
  });

  it("sous-titres : piste du conteneur, puis fichier à côté (en vol puis arrivé), puis aucun", async () => {
    data.info = info({ externalSubtitles: [{ id: -10, language: "spa", title: null, url: "/api/jellyfin/stream/subtitle/film-1?mediaSourceId=film-1&index=9" }] });
    let release: () => void = () => {};
    rec.respond((url) => {
      if (url.startsWith("/api/jellyfin/stream/subtitle/")) {
        return new Promise((resolve) => (release = () => resolve(standardResponder(url))));
      }
      return standardResponder(url);
    });
    await openAndPlay();
    await play(3);
    rec.step("sous-titre français (conteneur)");
    await pick("player.subtitles", /fran/i);
    await play(2);
    rec.step("fichier espagnol, en vol");
    await pick("player.subtitles", /espagnol/i);
    rec.step("anglais pendant que le fichier est en vol");
    await pick("player.subtitles", /anglais/i);
    release();
    await rec.flush();
    rec.step("fichier espagnol de nouveau, arrivé");
    await pick("player.subtitles", /espagnol/i);
    release();
    await rec.flush();
    await play(2);
    rec.dom("fichier affiché");
    rec.step("aucun");
    await pick("player.subtitles", /^player\.(subtitlesOff|off|none)/i);
    await play(1);
    await closeByCross();
    await fingerprint();
  });

  it("deux sous-titres : le principal, puis un second, puis le principal éteint", async () => {
    await openAndPlay();
    await play(2);
    await pick("player.subtitles", /fran/i);
    rec.step("second : anglais");
    await click(byLabel("player.subtitles"));
    await click(byText("player.dualSubtitles.title"));
    rec.dom("vue deux sous-titres");
    await click(Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").startsWith("player.dualSubtitles.second"))!);
    rec.dom("choix du second");
    const second = Array.from(document.querySelectorAll("button")).filter((b) => /anglais/i.test(b.textContent ?? ""));
    await click(second[second.length - 1]);
    await play(2);
    rec.dom("deux sous-titres");
    rec.step("principal éteint");
    await pick("player.subtitles", /^player\.none/);
    await play(1);
    rec.dom("aucun");
    await closeByCross();
    await fingerprint();
  });
});

describe("empreinte — lecteur natif : arrière-plan", () => {
  it("court aller-retour, puis longue absence avec source perdue", async () => {
    await openAndPlay();
    await play(10);
    rec.step("caché 3 s");
    setVisibility("hidden");
    await rec.advance(3_000);
    setVisibility("visible");
    await rec.advance(500);
    await play(2);
    rec.step("caché 90 s, source fermée");
    setVisibility("hidden");
    await rec.advance(90_000);
    current.lost = true;
    current.position = 132;
    setVisibility("visible");
    await rec.advance(1_000);
    await firstPicture(129);
    rec.dom("après retour");
    await closeByCross();
    await fingerprint();
  });
});

describe("empreinte — lecteur natif : réseau", () => {
  it("coupure en pleine lecture, écran, retour du réseau, reprise", async () => {
    await openAndPlay();
    await play(10);
    rec.step("coupure");
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("offline")));
    act(() => lastProbe().onError("plus de réseau", "network"));
    await rec.flush();
    rec.dom("coupure");
    await rec.advance(20_000);
    rec.step("réseau revenu");
    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("online")));
    await rec.advance(2_000);
    await firstPicture(130);
    rec.dom("repris");
    await closeByCross();
    await fingerprint();
  });

  it("source perdue à répétition : reconstructions, puis la main passée au lecteur serveur", async () => {
    await openAndPlay();
    await play(10);
    for (let i = 0; i < 6; i++) {
      rec.step(`perte ${i + 1}`);
      current.lost = true;
      current.position = 130 + i;
      act(() => lastProbe().onError("la source est morte"));
      await rec.advance(1_500);
    }
    rec.dom("après les pertes");
    await fingerprint();
  });

  it("ouverture qui n'aboutit jamais : le mot, le rapport, la main passée", async () => {
    pipe.next = () => new Promise(() => {});
    mount();
    await rec.flush();
    for (const at of [8_000, 12_000, 15_000]) {
      await rec.advance(at === 8_000 ? 8_000 : at - (at === 12_000 ? 8_000 : 12_000));
      rec.dom(`à ${at / 1000} s`);
    }
    await rec.advance(21_000);
    rec.dom("après 36 s");
    await fingerprint();
  });

  it("lien lent à l'ouverture : indice, préchauffage, bascule vers la version allégée", async () => {
    data.info = info({ sizeBytes: 1_170_000_000, runtimeSeconds: 2400 });
    pipe.next = () => new Promise(() => {});
    mount();
    await rec.advance(500);
    const request = meterOpeningRequest();
    request?.headers();
    for (let t = 0; t < 12; t++) {
      await rec.advance(1_000);
      request?.received(40_000);
      if (t === 4 || t === 8) rec.dom(`lien lent ${t + 1} s`);
    }
    rec.step("préchauffage prêt");
    warm.list[0]?.settle(true);
    await rec.flush();
    await rec.advance(1_000);
    rec.dom("après bascule");
    await fingerprint();
  });
});

describe("empreinte — lecteur natif : passer la main", () => {
  it("panne de lecture après l'image : la main au lecteur serveur avec la position et la piste", async () => {
    await openAndPlay();
    await play(30);
    rec.step("panne");
    act(() => lastProbe().onError("Media failed to decode", "playback"));
    await rec.advance(2_000);
    current.lost = true;
    current.position = 150;
    act(() => lastProbe().onError("Media failed to decode", "playback"));
    await rec.advance(2_000);
    await fingerprint();
  });

  it("AirPlay : le bouton, la confirmation, la main passée pour diffuser", async () => {
    (HTMLMediaElement.prototype as unknown as { webkitShowPlaybackTargetPicker: () => void }).webkitShowPlaybackTargetPicker = () => note("airplay", "picker");
    await openAndPlay();
    await play(5);
    rec.step("diffuser");
    await click(byLabel("player.cast"));
    rec.dom("confirmation");
    await click(byText("player.castConfirm.confirm"));
    await rec.flush();
    await fingerprint();
  });
});

describe("empreinte — lecteur natif : épisode suivant", () => {
  it("le bouton « épisode suivant »", async () => {
    noteWatching("ep-1");
    await openAndPlay({ itemId: "ep-1", title: "Épisode 1", episodes: true });
    await play(5);
    rec.step("suivant");
    await click(byLabel("player.nextEpisode"));
    await rec.flush();
    await fingerprint();
  });

  it("la carte du générique, et son décompte jusqu'au bout", async () => {
    data.info = info({ creditsStart: 3300 });
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

describe("empreinte — lecteur natif : écrans d'erreur", () => {
  it("serveur média injoignable", async () => {
    data.info = undefined;
    data.error = withCode(new Error("jellyfin.local ne répond pas (ECONNREFUSED)"), UPSTREAM_UNREACHABLE);
    mount();
    await rec.flush();
    await rec.advance(1_000);
    rec.dom("injoignable");
    await fingerprint();
  });

  it("fichier refusé par le serveur : la main tout de suite", async () => {
    data.info = info({ refusedReason: "conteneur avi" });
    mount();
    await rec.flush();
    await rec.advance(1_000);
    rec.dom("refusé");
    await fingerprint();
  });
});

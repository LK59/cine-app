// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor, fireEvent } from "@testing-library/react";

// « Connexion trop lente » dans le lecteur serveur (DECISIONS.md §77) : le chien de garde des 20 s
// regarde ce que hls.js a reçu avant de dire « trop long ». Sans preuve, rien ne change.

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
  PlayerControls: (props: { currentSubtitleId?: number | null; onChangeAudio?: (id: number) => void }) => (
    <div data-testid="commandes" data-subtitle={String(props.currentSubtitleId ?? "")}>
      <button type="button" data-testid="piste-2" onClick={() => props.onChangeAudio?.(2)} />
    </div>
  ),
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
/**
 * Les titres que le natif a passés au lecteur serveur : « film » ici, pour l'ouvrir directement, sauf
 * pour les tests de l'aiguillage (§78). (Jusqu'au 13/10/2026, la préférence « lecteur legacy » du
 * compte jouait ce rôle ; elle a disparu.)
 */
let handed: string[] = ["film"];
vi.mock("@/lib/useAccountPreferences", () => ({ useAccountPreferencesLoader: () => {} }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
/** Le relais du lecteur natif, quand un test en simule un (version allégée, §78). */
let stableTakeover: Record<string, unknown> | null = null;
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: handed, negotiating: false, reason: null, takeover: stableTakeover, stepAside: vi.fn(), stepBack: vi.fn(), returning: null }),
}));
const reported: { kind: string; fields: Record<string, unknown> }[] = [];
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (kind: string, fields: Record<string, unknown>) => void reported.push({ kind, fields }) }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
// Pas de HLS natif : hls.js.
// Safari (HLS natif, sans mesure) : les tests qui l'éprouvent le disent eux-mêmes.
let nativeHls = false;
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => nativeHls }));
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
  stopLoad: vi.fn(),
  recoverMediaError: vi.fn(),
  destroy: vi.fn(),
  config: null as null | { xhrSetup?: (xhr: XMLHttpRequest, url: string) => void },
};
vi.mock("hls.js", () => {
  class Hls {
    static isSupported = () => true;
    static Events = { FRAG_BUFFERED: "hlsFragBuffered", ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed", LEVEL_LOADED: "hlsLevelLoaded", MANIFEST_LOADED: "hlsManifestLoaded", FRAG_LOADING: "hlsFragLoading", FRAG_LOADED: "hlsFragLoaded" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" };
    bandwidthEstimate = 0;
    audioTracks = [];
    constructor(config: typeof fake.config) {
      fake.config = config;
    }
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
    stopLoad() {
      fake.stopLoad();
    }
    destroy() {
      fake.destroy();
    }
  }
  return { default: Hls };
});

import { PlayerHost } from "@/components/PlayerHost";
import { carriedLighter, forgetLighterCarry, writePlaybackQuality } from "@/lib/playbackQuality";
import { forgetPrewarm } from "@/lib/lighterPrewarm";

const reponse: Record<string, unknown> & { playbackInfo: Record<string, unknown> & { video: Record<string, unknown> & { bitRate: number } }; subtitleTracks: unknown[] } = {
  playSessionId: "seance-jf",
  sourceBitrateBps: 16_000_000,
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8?DeviceId=appareil-1&MediaSourceId=source&PlaySessionId=seance-jf",
  audioTracks: [],
  subtitleTracks: [],
  title: "Film",
  playbackInfo: {
    playMethod: "DirectStream",
    transcodeReasons: [],
    container: "ts",
    requestedVideoCodecs: [],
    video: { codec: "h264", profile: null, width: 1920, height: 1080, bitDepth: 8, frameRate: 24, bitRate: 3_500_000 },
    audio: { codec: "aac", channels: 2, bitRate: 400_000, language: "fre" },
  },
};

const startBodies: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1 });
  startBodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/jellyfin/playback/start") {
        startBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return { ok: true, status: 200, json: async () => reponse };
      }
      // Les listes et le segment d'un préchauffage (§78).
      if (String(url).includes("master.m3u8")) return { ok: true, status: 200, text: async (): Promise<string> => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS=\"hvc1.1.4.L120.B0,mp4a.40.2\"\nmain.m3u8?x=1\n" };
      if (String(url).includes("main.m3u8")) return { ok: true, status: 200, text: async (): Promise<string> => "#EXTM3U\n#EXTINF:3.003,\nhls1/main/0.mp4\n#EXTINF:3.003,\nhls1/main/1.mp4\n#EXT-X-ENDLIST\n" };
      if (String(url).includes("/hls1/main/")) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1000) };
      return { ok: true, status: 200, json: async () => ({}), text: async (): Promise<string> => "" };
    })
  );
  playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film" };
  writePlaybackQuality("auto");
  fake.listeners = new Map();
  fake.config = null;
  fake.stopLoad.mockClear();
  fake.destroy.mockClear();
  nativeHls = false;
  reported.length = 0;
  stableTakeover = null;
  handed = ["film"];
  forgetLighterCarry();
  forgetPrewarm();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Le relais du lecteur natif après une bascule sur ce palier (§78) — la seule façon d'en avoir un, hors règle des deux minutes. */
function switchedTo(step: { targetBps: number; tier: number }, over: Record<string, unknown> = {}) {
  stableTakeover = { resumeAt: 0, lighter: step, owner: playback.session, ...over };
}

/** Monté, avec hls.js construit — en tours de boucle, les minuteurs étant simulés. */
async function mounted() {
  render(<PlayerHost />);
  for (let i = 0; i < 200 && !fake.config; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  expect(fake.config?.xhrSetup).toBeTypeOf("function");
}

/** Le mot sous la ligne de chargement de l'ouverture (§60), s'il y en a un. */
const introNote = () => document.querySelector("[data-playback-intro-note]")?.textContent ?? null;

/**
 * Une requête d'hls.js qui reçoit `bytesPerSecond` pendant `seconds`, sans finir. Rend, seconde par
 * seconde, le mot sous la ligne de chargement.
 */
async function trickle(bytesPerSecond: number | ((t: number) => number), seconds: number) {
  const xhr = new EventTarget() as EventTarget & { readyState: number };
  xhr.readyState = 0;
  fake.config!.xhrSetup!(xhr as unknown as XMLHttpRequest, "/api/jellyfin/stream/film/segment0.ts");
  xhr.readyState = 2;
  xhr.dispatchEvent(new Event("readystatechange"));
  const seen: (string | null)[] = [];
  let loaded = 0;
  for (let t = 1; t <= seconds; t++) {
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    const bytes = typeof bytesPerSecond === "function" ? bytesPerSecond(t) : bytesPerSecond;
    if (bytes > 0) {
      loaded += bytes;
      xhr.dispatchEvent(Object.assign(new Event("progress"), { loaded }));
    }
    seen.push(introNote());
  }
  return seen;
}

describe("le chien de garde des 20 s", () => {
  it("connexion normale (ou rien de mesuré) : « trop long », comme avant", async () => {
    await mounted();
    await act(async () => void (await vi.advanceTimersByTimeAsync(21_000)));
    expect(document.body.textContent).toContain("player.loadingTooLong");
    expect(reported.find((r) => r.kind === "error")?.fields.reason).toBe("pas de première image en 20 s");
  });

  it("un lien qui livre bien mais sans image : « trop long », comme avant", async () => {
    await mounted();
    await trickle(2_000_000, 21);
    expect(document.body.textContent).toContain("player.loadingTooLong");
  });

  it("≈0,3 Mbit/s pour 3,9 demandés : la cause, nommée, avec ses chiffres (« Originale » : sans bascule)", async () => {
    writePlaybackQuality("original");
    await mounted();
    await trickle(40_000, 21);
    expect(document.body.textContent).toContain("player.slowLink.failed");
    expect(document.body.textContent).not.toMatch(/\d+[,.]\d+ ?Mbit/);
    expect(document.body.textContent).not.toContain("player.loadingTooLong");
    const line = reported.find((r) => r.kind === "error")!.fields;
    expect(line).toMatchObject({ reason: "connexion trop lente", needMbps: 3.9, path: "serveur" });
    expect(line.recvMbps).toBeCloseTo(0.32, 1);
    expect(line.measuredS).toBeGreaterThanOrEqual(10);
  });

  // Passe de nuit du 15/10/2026 (LECTEUR-5) : l'écran ne faisait que s'afficher, hls.js continuait
  // de charger et le film démarrait sous lui, 6 à 30 s plus tard, sans que l'écran parte jamais.
  it("l'écran « trop long » arrête le chargement d'hls.js — « Réessayer » repart de zéro", async () => {
    await mounted();
    expect(fake.destroy).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(21_000)));
    expect(document.body.textContent).toContain("player.loadingTooLong");
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    // Réessayer : une nouvelle négociation, un nouvel hls.js — le chemin d'avant, inchangé.
    fake.config = null;
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "common.retry")!);
    for (let i = 0; i < 200 && !fake.config; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(startBodies).toHaveLength(2);
    expect(fake.config).not.toBeNull();
    expect(document.body.textContent).not.toContain("player.loadingTooLong");
  });

  it("l'écran « connexion trop lente » arrête lui aussi le chargement", async () => {
    writePlaybackQuality("original");
    await mounted();
    await trickle(40_000, 21);
    expect(document.body.textContent).toContain("player.slowLink.failed");
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it("Safari (HLS natif) : l'écran met l'élément en pause, sans toucher à sa source", async () => {
    nativeHls = true;
    render(<PlayerHost />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    const src = document.querySelector("video")!.getAttribute("src");
    expect(src).toBeTruthy();
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    await act(async () => void (await vi.advanceTimersByTimeAsync(16_000)));
    expect(document.body.textContent).toContain("player.loadingTooLong");
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(document.querySelector("video")!.getAttribute("src")).toBe(src);
  });

  it("le bilan `stop` porte le verdict du lien sous `diag`", async () => {
    writePlaybackQuality("original");
    await mounted();
    await trickle(40_000, 21);
    // Démonté : le bilan part (`why: "unmount"`).
    cleanup();
    const stop = reported.find((r) => r.kind === "stop");
    expect(stop?.fields.diag).toMatchObject({ linkVerdict: "trop lente", needMbps: 3.9 });
  });
});

describe("le débit demandé à Jellyfin", () => {
  it("inchangé sans mesure", async () => {
    await mounted();
    expect(startBodies[0].maxBitrate).toBe(100_000_000);
  });

  it("abaissé au palier de version allégée de ce titre, avec la largeur de son barème", async () => {
    switchedTo({ targetBps: 2_500_000, tier: 1 });
    await mounted();
    expect(startBodies[0]).toMatchObject({ maxBitrate: 2_500_000, lighter: true });
    expect(reported.find((r) => r.kind === "start")!.fields).toMatchObject({ lighterMbps: 2.5, lighterTier: 1 });
  });

  it("« Originale » : une séance qui hérite d'un palier repart en pleine qualité — aucun plafond allégé", async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film", lighter: { targetBps: 2_500_000, tier: 1 } };
    writePlaybackQuality("original");
    await mounted();
    expect(startBodies[0].maxBitrate).toBe(100_000_000);
    expect(startBodies[0].lighter).toBeUndefined();
  });

  it("une diffusion (AirPlay) n'hérite jamais du palier : le téléviseur a son propre lien", async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film", lighter: { targetBps: 2_500_000, tier: 1 } };
    stableTakeover = { resumeAt: 0, cast: true, owner: playback.session };
    await mounted();
    expect(startBodies[0]).toMatchObject({ forCast: true, maxBitrate: 100_000_000 });
    expect(startBodies[0].lighter).toBeUndefined();
  });

  it("le banc d'essai n'hérite jamais du palier : il reste au lecteur natif", async () => {
    handed = [];
    playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film", bench: true, lighter: { targetBps: 2_500_000, tier: 1 } };
    render(<PlayerHost />);
    expect(document.querySelector("[data-testid=natif]")).not.toBeNull();
  });

  it("sans palier, la demande d'avant à l'octet : ni plafond abaissé, ni largeur", async () => {
    await mounted();
    expect(startBodies[0].lighter).toBeUndefined();
    expect(reported.find((r) => r.kind === "start")!.fields.lighterMbps).toBeUndefined();
  });
});

describe("les étapes du démarrage et la chronologie, sur les lignes du lecteur serveur", () => {
  /** Les champs tels que la route les compte : aplatis d'un niveau, hors `diag.*` et `timeline`. */
  const counted = (fields: Record<string, unknown>) =>
    Object.entries(fields)
      .flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).map((s) => `${k}.${s}`) : [k]))
      .filter((k) => !k.startsWith("diag.") && k !== "timeline" && !["build", "version", "resent", "lateByMs", "sleepTimer"].includes(k));

  it("`start` porte la négociation ; l'échec, ses étapes et l'étape atteinte ; le bilan tient dans le plafond", async () => {
    writePlaybackQuality("original");
    await mounted();
    const start = reported.find((r) => r.kind === "start")!.fields;
    expect((start.startup as Record<string, number>).negotiateMs).toBeTypeOf("number");
    const listeners = (event: string) => fake.listeners.get(event) ?? [];
    act(() => {
      for (const cb of listeners("hlsManifestLoaded")) cb("hlsManifestLoaded", { stats: { loaded: 120_000, loading: { start: 1, first: 2, end: 3 } } });
    });
    await trickle(40_000, 21);
    const error = reported.find((r) => r.kind === "error")!.fields;
    expect(error.startup).toMatchObject({ masterKB: 120, stage: "liste" });
    cleanup();
    const stop = reported.find((r) => r.kind === "stop")!.fields;
    expect(stop.startup).toMatchObject({ stage: "liste" });
    expect(counted(stop).length).toBeLessThanOrEqual(40);
  });
});

/**
 * La connexion lente sur le lecteur serveur (DECISIONS.md §78) : l'indice, le préchauffage du palier
 * suivant, la bascule automatique en reprenant ce préchauffage, l'écran final, le réglage « Qualité ».
 */
describe("pendant le chargement : indice, préchauffage, bascule (§78)", () => {
  const errors = () => reported.filter((r) => r.kind === "error");
  const starts = () => reported.filter((r) => r.kind === "start");
  const negotiations = () => startBodies.filter((b) => b.prewarm !== true);
  const prewarmBodies = () => startBodies.filter((b) => b.prewarm === true);
  const settleAll = async () => {
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  };

  it("bon réseau : ni indice ni préchauffage — « trop long » à 20 s, comme avant, et pas une requête de plus", async () => {
    await mounted();
    const seen = await trickle(2_000_000, 21);
    expect(seen).not.toContain("player.slowLink.hint");
    expect(prewarmBodies()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
    expect(errors()[0].fields.slowLink).toBeUndefined();
  });

  it("très lente : l'indice dès 5 s, le préchauffage à 8 s, la bascule qui REPREND le préchauffage (même séance Jellyfin, aucune négociation de plus)", async () => {
    await mounted();
    await trickle(40_000, 9);
    expect(prewarmBodies()).toHaveLength(1);
    expect(prewarmBodies()[0]).toMatchObject({ itemId: "film", maxBitrate: 1_500_000, lighter: true, prewarm: true });
    await settleAll();
    await trickle(40_000, 2);
    await settleAll();
    // Une seule négociation de lecture : la première ; la bascule a repris la réponse du préchauffage.
    expect(negotiations()).toHaveLength(1);
    const second = starts()[1]?.fields;
    expect(second).toMatchObject({ why: "lighter", lighterTier: 1, lighterMbps: 1.5 });
    expect(second.prewarm).toMatchObject({ used: true, tier: 1 });
    // hls.js part du segment préchauffé.
    expect((fake.config as Record<string, unknown>).startPosition).toBe(0);
    expect(errors()).toHaveLength(0);
    // Le message bref de la bascule.
    expect(document.querySelector("[data-lighter-switch-notice]")?.textContent).toBe("player.slowLink.switched");
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_500)));
    expect(document.querySelector("[data-lighter-switch-notice]")).toBeNull();
  });

  it("dégressif : la version allégée en cours bloque encore — palier suivant ; au plancher, l'écran final (Réessayer · Quitter)", async () => {
    reponse.playbackInfo.video.bitRate = 4_600_000;
    try {
      switchedTo({ targetBps: 5_000_000, tier: 1 });
      await mounted();
      await trickle(40_000, 12);
      await settleAll();
      const switched = starts().find((s) => s.fields.why === "lighter")?.fields;
      expect(switched).toMatchObject({ lighterTier: 2, lighterMbps: 1.5 });
    } finally {
      reponse.playbackInfo.video.bitRate = 3_500_000;
    }
    cleanup();
    fake.config = null;
    reported.length = 0;
    startBodies.length = 0;
    switchedTo({ targetBps: 1_500_000, tier: 3 });
    await mounted();
    await trickle(40_000, 21);
    expect(prewarmBodies()).toHaveLength(0);
    expect(errors()[0].fields.reason).toBe("connexion trop lente");
    expect(document.body.textContent).toContain("player.slowLink.failed");
    expect(screenLabels()).not.toContain("player.slowLink.lighter");
  });

  it("« Originale » : jamais de préchauffage ni de bascule — l'indice, puis l'écran final à 20 s", async () => {
    writePlaybackQuality("original");
    await mounted();
    await trickle(40_000, 21);
    expect(prewarmBodies()).toHaveLength(0);
    expect(errors()[0].fields).toMatchObject({ reason: "connexion trop lente", quality: "original" });
    expect(document.body.textContent).toContain("player.slowLink.failed");
  });

  it("banc d'essai : ni préchauffage ni bascule — l'écran final, comme « Originale »", async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film", bench: true };
    await mounted();
    await trickle(40_000, 21);
    expect(prewarmBodies()).toHaveLength(0);
    expect(starts().filter((s) => s.fields.why === "lighter")).toHaveLength(0);
    expect(errors()[0].fields.reason).toBe("connexion trop lente");
  });

  it("version allégée non permise au compte (politique Jellyfin) : comme « Originale »", async () => {
    reponse.lighterAllowed = false;
    try {
      await mounted();
      await trickle(40_000, 21);
      expect(prewarmBodies()).toHaveLength(0);
      expect(errors()[0].fields.reason).toBe("connexion trop lente");
    } finally {
      delete reponse.lighterAllowed;
    }
  });

  it("le chien de garde renonce sans lenteur prouvée : le préchauffage lancé à 8 s est arrêté chez Jellyfin", async () => {
    // ~12 Ko/s : sous la moitié du besoin dès 5 s (indice, préchauffage à 8 s), mais moins de 256 Kio en
    // 20 s — pas de verdict. L'écran « trop long » restait affiché devant un transcodage préchauffé que
    // rien n'arrêtait avant la fermeture du lecteur (le natif, lui, le laisse tomber en renonçant).
    await mounted();
    await trickle(12_000, 21);
    await settleAll();
    expect(prewarmBodies()).toHaveLength(1);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
    const stops = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url, init]) => url === "/api/jellyfin/playback/stop" && JSON.parse(String((init as RequestInit).body)).prewarm === true
    );
    expect(stops).toHaveLength(1);
  });

  it("la première image arrive : le préchauffage est arrêté chez Jellyfin (aucun transcodage orphelin)", async () => {
    await mounted();
    await trickle(40_000, 9);
    await settleAll();
    expect(prewarmBodies()).toHaveLength(1);
    await act(async () => void fireEvent(document.querySelector("video")!, new Event("loadeddata")));
    await settleAll();
    const stopCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url, init]) => url === "/api/jellyfin/playback/stop" && JSON.parse(String((init as RequestInit).body)).prewarm === true
    );
    expect(stopCall).toBeTruthy();
    expect(JSON.parse(String((stopCall![1] as RequestInit).body))).toMatchObject({ playSessionId: "seance-jf", deviceId: "appareil-1" });
    expect(starts().filter((s) => s.fields.why === "lighter")).toHaveLength(0);
  });

  it("C : hors ligne pendant le chargement — ni indice ni préchauffage, jamais de bascule ; l'ancien « trop long »", async () => {
    await mounted();
    await trickle(40_000, 6);
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("offline")));
    try {
      await trickle(40_000, 15);
      expect(prewarmBodies()).toHaveLength(0);
      expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
    } finally {
      Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
    }
  });

  it("E : Safari (HLS natif, rien de mesuré) — rien ne change : « Le chargement prend trop de temps. Réessaie. »", async () => {
    nativeHls = true;
    render(<PlayerHost />);
    const seen: (string | null)[] = [];
    for (let t = 0; t < 21; t++) {
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
      seen.push(introNote());
    }
    expect(seen).not.toContain("player.slowLink.hint");
    expect(prewarmBodies()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
    expect(document.body.textContent).toContain("player.loadingTooLong");
  });
});

/** Les libellés des boutons de la page. */
function screenLabels() {
  return Array.from(document.querySelectorAll("button")).map((b) => b.textContent);
}

describe("la lecture allégée : relais, règle des deux minutes, lien rétabli (§78)", () => {
  const video = () => document.querySelector("video")!;
  /**
   * Un segment qui arrive au rythme de hls.js (une progression toutes les 250 ms) à `bytesPerSecond`,
   * pendant `seconds` secondes : la capacité du lien, mesurée pendant la réception.
   */
  async function flow(bytesPerSecond: number, seconds: number) {
    const xhr = new EventTarget() as EventTarget & { readyState: number };
    xhr.readyState = 0;
    fake.config!.xhrSetup!(xhr as unknown as XMLHttpRequest, "/api/jellyfin/stream/film/segment9.mp4");
    xhr.readyState = 2;
    xhr.dispatchEvent(new Event("readystatechange"));
    let loaded = 0;
    for (let q = 0; q < seconds * 4; q++) {
      await act(async () => void (await vi.advanceTimersByTimeAsync(250)));
      loaded += bytesPerSecond / 4;
      xhr.dispatchEvent(Object.assign(new Event("progress"), { loaded }));
    }
  }
  async function picture() {
    await act(async () => void fireEvent(video(), new Event("loadeddata")));
    await act(async () => void fireEvent(video(), new Event("playing")));
  }

  it("le relais du lecteur natif garde le sous-titre choisi, et dit brièvement qu'une génération ne suivra pas", async () => {
    reponse.subtitleTracks = [{ index: 7, language: "fre", title: null, isDefault: false, url: "/sous-titre" }];
    try {
      switchedTo({ targetBps: 1_500_000, tier: 1 }, { resumeAt: 600, subtitleStreamIndex: 7, subtitleGenerating: true });
      await mounted();
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(document.querySelector("[data-testid=commandes]")!.getAttribute("data-subtitle")).toBe("7");
      expect(document.querySelector("[data-subtitle-gen-notice]")?.textContent).toBe("player.slowLink.subtitlesGenerating");
      await act(async () => void (await vi.advanceTimersByTimeAsync(6500)));
      expect(document.querySelector("[data-subtitle-gen-notice]")).toBeNull();
      expect(startBodies[0]).toMatchObject({ maxBitrate: 1_500_000, startTicks: 600 * 10_000_000 });
    } finally {
      reponse.subtitleTracks = [];
    }
  });

  it("l'aiguillage : sans palier hérité, le lecteur natif ; avec, le lecteur serveur ; le relais allégé aussi", async () => {
    handed = [];
    render(<PlayerHost />);
    expect(document.querySelector("[data-testid=natif]")).not.toBeNull();
    cleanup();
    playback.session = { itemId: "film", openId: 2, resumeAt: 0, title: "Film", lighter: { targetBps: 2_500_000, tier: 1 } };
    render(<PlayerHost />);
    expect(document.querySelector("[data-testid=natif]")).toBeNull();
    cleanup();
    playback.session = { itemId: "film", openId: 3, resumeAt: 0, title: "Film" };
    switchedTo({ targetBps: 2_500_000, tier: 1 });
    render(<PlayerHost />);
    expect(document.querySelector("[data-testid=natif]")).toBeNull();
  });

  it("moins de 2 min après une séance allégée : la lecture part directement au palier hérité (`lighterCarried`)", async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film", lighter: { targetBps: 2_500_000, tier: 1 } };
    await mounted();
    expect(startBodies[0]).toMatchObject({ maxBitrate: 2_500_000, lighter: true });
    expect(reported.find((r) => r.kind === "start")!.fields).toMatchObject({ lighterCarried: true, lighterTier: 1 });
  });

  // Un appareil restait au lecteur serveur tant qu'on relançait vite (12/10/2026) : chaque séance
  // héritée repoussait les deux minutes. Seule une vraie bascule réarme la mémoire.
  it("une séance seulement héritée ne réarme pas la mémoire des deux minutes", async () => {
    forgetLighterCarry();
    playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film", lighter: { targetBps: 2_500_000, tier: 1 } };
    await mounted();
    await picture();
    cleanup();
    expect(carriedLighter()).toBeNull();
  });

  it("une séance allégée qui s'arrête est retenue deux minutes", async () => {
    switchedTo({ targetBps: 2_500_000, tier: 1 });
    await mounted();
    await picture();
    cleanup();
    expect(carriedLighter()).toEqual({ targetBps: 2_500_000, tier: 1 });
  });

  it("une seule mémoire : un titre déjà allégé, rouvert hors de la règle des deux minutes, repart en pleine qualité et ne réarme rien", async () => {
    switchedTo({ targetBps: 2_500_000, tier: 1 });
    await mounted();
    await picture();
    cleanup();
    expect(carriedLighter()).toEqual({ targetBps: 2_500_000, tier: 1 });
    // Plus de deux minutes après : la mémoire n'existe plus ; une séance serveur ordinaire du même titre.
    forgetLighterCarry();
    stableTakeover = null;
    fake.config = null;
    startBodies.length = 0;
    playback.session = { itemId: "film", openId: 2, resumeAt: 0, title: "Film" };
    await mounted();
    expect(startBodies[0].lighter).toBeUndefined();
    expect(startBodies[0].maxBitrate).toBe(100_000_000);
    await picture();
    cleanup();
    expect(carriedLighter()).toBeNull();
  });

  it("un saut fait en pause n'est jamais traité comme une ouverture", async () => {
    await mounted();
    await picture();
    Object.defineProperty(video(), "paused", { value: true, configurable: true });
    await act(async () => void fireEvent(video(), new Event("seeking")));
    await act(async () => void fireEvent(video(), new Event("seeked")));
    await trickle(40_000, 15);
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(0);
    expect(reported.filter((r) => r.kind === "error")).toHaveLength(0);
  });

  it("un saut en lecture resté 10 s sans image : préchauffé et basculé à la position DEMANDÉE, pas à celle d'avant le saut", async () => {
    // Pendant un saut, l'élément n'a plus d'image (`readyState` < HAVE_CURRENT_DATA) : `timeupdate` ne
    // met plus à jour la position connue, qui reste celle d'avant le saut. Le préchauffage et la
    // bascule partaient de là — le spectateur sautait à 50 min et se retrouvait à 16 (13/10/2026).
    await mounted();
    await picture();
    await trickle(250_000, 1);
    Object.defineProperty(video(), "paused", { value: false, configurable: true });
    Object.defineProperty(video(), "seeking", { value: true, configurable: true });
    Object.defineProperty(video(), "currentTime", { value: 3000, configurable: true, writable: true });
    await act(async () => void fireEvent(video(), new Event("seeking")));
    await trickle(40_000, 12);
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const prewarms = startBodies.filter((b) => b.prewarm === true);
    expect(prewarms).toHaveLength(1);
    expect(prewarms[0].startTicks).toBe(3000 * 10_000_000);
    const lighter = reported.filter((r) => r.kind === "start" && r.fields.why === "lighter");
    expect(lighter).toHaveLength(1);
    expect(lighter[0].fields.at).toBe(3000);
  });

  it("le lien à 115 % du besoin classique pendant 10 s : la mémoire s'efface — la lecture suivante sera native", async () => {
    switchedTo({ targetBps: 2_500_000, tier: 1 });
    await mounted();
    await picture();
    // 16 Mbit/s en pleine qualité ; 18,4 Mbit/s de capacité (115 %). Les premières secondes d'une
    // réception lisent un peu bas (le morceau en cours n'a pas encore dit ses octets) : la capacité
    // passe 110 % vers la 6e seconde, et doit tenir 10 s de plus.
    await flow(2_300_000, 20);
    cleanup();
    expect(carriedLighter()).toBeNull();
    const stop = reported.find((r) => r.kind === "stop")!.fields;
    expect(stop.lighterCleared).toBe(true);
    expect(stop.slowLink).toContain("lien rétabli");
  });

  it("le lien à 100 % du besoin classique : la mémoire reste — la lecture suivante sera allégée", async () => {
    switchedTo({ targetBps: 2_500_000, tier: 1 });
    await mounted();
    await picture();
    await flow(2_000_000, 30);
    cleanup();
    expect(carriedLighter()).toEqual({ targetBps: 2_500_000, tier: 1 });
  });

  it("B : un blocage réseau de plus de 5 s pendant la lecture — préchauffage du palier, puis bascule à la position courante ; aucune erreur", async () => {
    await mounted();
    await picture();
    await act(async () => void fireEvent(video(), new Event("waiting")));
    await trickle(250_000, 6);
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(1);
    expect(reported.filter((r) => r.kind === "start" && r.fields.why === "lighter")).toHaveLength(1);
    expect(reported.filter((r) => r.kind === "error")).toHaveLength(0);
  });

  it("B : le 2e blocage réseau de plus d'1 s préchauffe sans basculer ; le 3e bascule sur ce préchauffage, déjà prêt", async () => {
    await mounted();
    await picture();
    const stallFor = async (seconds: number) => {
      await act(async () => void fireEvent(video(), new Event("waiting")));
      await trickle(250_000, seconds);
      await act(async () => void fireEvent(video(), new Event("playing")));
      for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    };
    await stallFor(2);
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(0);
    await stallFor(2);
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(1);
    expect(reported.filter((r) => r.kind === "start" && r.fields.why === "lighter")).toHaveLength(0);
    await stallFor(2);
    // Le même préchauffage, repris : aucune négociation de plus.
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(1);
    const lighter = reported.filter((r) => r.kind === "start" && r.fields.why === "lighter");
    expect(lighter).toHaveLength(1);
    expect(lighter[0].fields.prewarm).toMatchObject({ used: true });
    expect(String(lighter[0].fields.slowLink)).toContain("préchauffage (2e blocage)");
  });

  it("B : un 2e blocage sans 3e dans la minute — le préchauffage est arrêté chez Jellyfin, aucune bascule", async () => {
    await mounted();
    await picture();
    for (let n = 0; n < 2; n++) {
      await act(async () => void fireEvent(video(), new Event("waiting")));
      await trickle(250_000, 2);
      await act(async () => void fireEvent(video(), new Event("playing")));
    }
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(1);
    const stops = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/api/jellyfin/playback/stop");
    expect(stops()).toHaveLength(0);
    await act(async () => void (await vi.advanceTimersByTimeAsync(61_000)));
    expect(stops()).toHaveLength(1);
    expect(reported.filter((r) => r.kind === "start" && r.fields.why === "lighter")).toHaveLength(0);
  });

  /** Un blocage réseau de `seconds` secondes, puis l'image qui repart. */
  async function stallFor(seconds: number) {
    await act(async () => void fireEvent(video(), new Event("waiting")));
    await trickle(250_000, seconds);
    await act(async () => void fireEvent(video(), new Event("playing")));
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  }
  const prewarmStops = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url, init]) => url === "/api/jellyfin/playback/stop" && JSON.parse(String((init as RequestInit).body)).prewarm === true
    );

  it("une renégociation (piste audio) pendant qu'un préchauffage d'un autre palier attend : il est refermé chez Jellyfin, et le 3e blocage bascule quand même", async () => {
    // Séance déjà allégée au palier 1 : le 2e blocage préchauffe le palier 2. Un changement de piste
    // renégocie le palier 1, prend ce préchauffage, l'écarte (pas le bon palier)… et ne le refermait pas :
    // `cancelPrewarm` ignore un préchauffage pris. L'exécution le tenait encore « en cours » : plus aucune
    // bascule de toute la séance (13/10/2026).
    switchedTo({ targetBps: 5_000_000, tier: 1 });
    await mounted();
    await picture();
    await stallFor(2);
    await stallFor(2);
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(1);
    expect(startBodies.find((b) => b.prewarm === true)).toMatchObject({ maxBitrate: 1_500_000 });
    await act(async () => void fireEvent.click(document.querySelector("[data-testid=piste-2]")!));
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(prewarmStops()).toHaveLength(1);
    await picture();
    await stallFor(2);
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const lighter = reported.filter((r) => r.kind === "start" && r.fields.why === "lighter");
    expect(lighter).toHaveLength(1);
    expect(lighter[0].fields).toMatchObject({ lighterTier: 2, lighterMbps: 1.5 });
  });

  it("un préchauffage fait pour une autre piste audio n'est jamais repris : la bascule renégocie la piste choisie", async () => {
    // Le 2e blocage préchauffe avec la piste d'alors ; le spectateur change de piste ; le 3e bascule. Le
    // préchauffage repris tel quel jouait l'ancienne piste sous un menu qui disait la nouvelle.
    await mounted();
    await picture();
    await stallFor(2);
    await stallFor(2);
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(1);
    await act(async () => void fireEvent.click(document.querySelector("[data-testid=piste-2]")!));
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await picture();
    await stallFor(2);
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const lighter = reported.filter((r) => r.kind === "start" && r.fields.why === "lighter");
    expect(lighter).toHaveLength(1);
    expect(lighter[0].fields.prewarm).toBeUndefined();
    expect(startBodies.filter((b) => b.prewarm !== true && b.lighter === true).at(-1)).toMatchObject({ audioStreamIndex: 2 });
    // Le préchauffage écarté est refermé chez Jellyfin.
    expect(prewarmStops()).toHaveLength(1);
  });

  it("« Originale » choisie pendant qu'un préchauffage de saccades se prépare : il est arrêté chez Jellyfin, aucune bascule", async () => {
    // La règle de bascule a joué (blocage de plus de 5 s) : le préchauffage part, la bascule l'attend.
    // Le spectateur choisit « Originale » dans le menu. Prêt, le préchauffage n'était plus jamais ni
    // repris ni refermé — un transcodage tenu chez Jellyfin jusqu'à la fermeture du lecteur.
    const realFetch = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    let release: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (String(url).includes("/hls1/main/")) return new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1000) })));
        return realFetch(url, init);
      })
    );
    await mounted();
    await picture();
    await act(async () => void fireEvent(video(), new Event("waiting")));
    await trickle(250_000, 6);
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(1);
    await act(async () => writePlaybackQuality("original"));
    release();
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(reported.filter((r) => r.kind === "start" && r.fields.why === "lighter")).toHaveLength(0);
    expect(prewarmStops()).toHaveLength(1);
  });

  // La règle de Louis (15/10/2026, §78) : une mesure seule n'agit jamais — seul un blocage réel le peut.
  it("une lecture qui joue sur un lien mesuré très lent, sans aucun blocage : ni préchauffage ni bascule", async () => {
    await mounted();
    await picture();
    // Deux minutes à 0,25 Mo/s (2 Mbit/s pour un besoin de 3,9) : la mesure dit « lent », l'image ne s'arrête pas.
    await trickle(250_000, 120);
    for (let i = 0; i < 30; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(0);
    expect(reported.filter((r) => r.kind === "start" && r.fields.why === "lighter")).toHaveLength(0);
  });

  it("B en « Originale » : rien — jamais d'erreur tant que la lecture continue", async () => {
    writePlaybackQuality("original");
    await mounted();
    await picture();
    await act(async () => void fireEvent(video(), new Event("waiting")));
    await trickle(250_000, 6);
    expect(startBodies.filter((b) => b.prewarm === true)).toHaveLength(0);
    expect(reported.filter((r) => r.kind === "error")).toHaveLength(0);
  });
});

describe("les messages brefs de la version allégée et les écrans qui prennent tout (chasse aux défauts, 13/10/2026)", () => {
  it("« Passage en vidéo allégée… » ne reste pas posé sur l'écran d'erreur", async () => {
    // Le relais arrive avec son message bref, et la négociation de la version allégée échoue : l'écran
    // d'erreur (« Quitter · Réessayer ») prenait l'écran, commandes cachées — et le message restait
    // par-dessus, en bas à gauche, annonçant une bascule qui n'avait pas abouti.
    switchedTo({ targetBps: 1_500_000, tier: 1 }, { switchedAt: Date.now() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/jellyfin/playback/start") return { ok: false, status: 503, json: async () => ({ error: "Lecture impossible pour le moment." }) };
        return { ok: true, status: 200, json: async () => ({}), text: async (): Promise<string> => "" };
      })
    );
    render(<PlayerHost />);
    for (let i = 0; i < 50; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(document.body.textContent).toContain("Lecture impossible pour le moment.");
    expect(document.querySelector("[data-lighter-switch-notice]")).toBeNull();
  });
});

// Le relais préparé avant une zone illisible (DECISIONS.md §93) : la même mécanique de préchauffage,
// en négociation ordinaire — reprise telle quelle par le lecteur serveur quand elle convient.
describe("le relais d'une zone illisible (§93)", () => {
  const negotiations = () => startBodies.filter((b) => b.prewarm !== true);
  const prewarmBodies = () => startBodies.filter((b) => b.prewarm === true);
  const starts = () => reported.filter((r) => r.kind === "start");

  async function prewarmed(startSeconds: number) {
    const { startPrewarm } = await import("@/lib/lighterPrewarm");
    const prewarm = startPrewarm({ itemId: "film", step: null, startSeconds, maxBitrate: 8_000_000 });
    for (let i = 0; i < 20 && prewarm.state === "running"; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(prewarm.state).toBe("ready");
    return prewarm;
  }

  it("le lecteur serveur reprend le préchauffage ordinaire : aucune négociation de plus, hls.js part de sa position", async () => {
    await prewarmed(600);
    expect(prewarmBodies()[0]).toMatchObject({ itemId: "film", maxBitrate: 8_000_000, prewarm: true, startTicks: 600 * 10_000_000 });
    expect(prewarmBodies()[0].lighter).toBeUndefined();
    stableTakeover = { resumeAt: 600, switchedAt: Date.now(), owner: playback.session };
    await mounted();
    expect(negotiations()).toHaveLength(0);
    expect(starts()[0].fields.prewarm).toMatchObject({ used: true, ordinary: 1 });
    expect((fake.config as Record<string, unknown>).startPosition).toBe(600);
  });

  it("préparé ailleurs (un saut dans la zone) : arrêté chez Jellyfin, la négociation se fait comme avant", async () => {
    await prewarmed(300);
    stableTakeover = { resumeAt: 600, switchedAt: Date.now(), owner: playback.session };
    await mounted();
    expect(negotiations()).toHaveLength(1);
    expect(negotiations()[0]).toMatchObject({ startTicks: 600 * 10_000_000 });
    const stops = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/api/jellyfin/playback/stop");
    expect(stops.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([expect.objectContaining({ prewarm: true, playSessionId: "seance-jf" })]);
    expect(starts()[0].fields.prewarm).toBeUndefined();
  });

  it("Safari en HLS natif ne le reprend jamais : arrêté, négociation ordinaire", async () => {
    await prewarmed(600);
    nativeHls = true;
    stableTakeover = { resumeAt: 600, switchedAt: Date.now(), owner: playback.session };
    render(<PlayerHost />);
    for (let i = 0; i < 50 && negotiations().length === 0; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(negotiations()).toHaveLength(1);
  });

  it("une bascule allégée ne prend jamais un préchauffage ordinaire (et inversement)", async () => {
    const { takePrewarm, takeOrdinaryPrewarm, startPrewarm } = await import("@/lib/lighterPrewarm");
    await prewarmed(600);
    expect(takePrewarm("film")).toBeNull();
    const lighter = startPrewarm({ itemId: "film", step: { targetBps: 1_500_000, tier: 1 }, startSeconds: 600 });
    expect(takeOrdinaryPrewarm("film", 600, undefined)).toBeNull();
    expect(takePrewarm("film")).toBe(lighter);
  });
});

/**
 * La reprise du lecteur serveur (LECTEUR-2, 15/10/2026) : `startup.pictureMs` est la première image,
 * prise au `loadeddata` — avant le saut à la position de reprise. Le bilan dit désormais ce que l'image
 * À LA POSITION DE REPRISE a coûté.
 */
describe("la reprise du lecteur serveur", () => {
  const video = () => document.querySelector("video")!;

  it("le bilan porte le saut de reprise et l'image à la position demandée (`diag.resume*`)", async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 1200, title: "Film" };
    await mounted();
    await act(async () => void fireEvent(video(), new Event("loadeddata")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(1500)));
    await act(async () => void fireEvent(video(), new Event("seeked")));
    cleanup();
    const stop = reported.find((r) => r.kind === "stop")!.fields;
    const diag = stop.diag as Record<string, number>;
    // La reprise recule de 5 s (« se remettre dans la scène ») : 1 195.
    expect(diag.resumeAt).toBe(1195);
    expect(diag.resumeSeekMs).toBeTypeOf("number");
    expect(diag.resumePictureMs - diag.resumeSeekMs).toBeGreaterThanOrEqual(1500);
  });

  it("sans reprise : aucun champ de plus", async () => {
    await mounted();
    await act(async () => void fireEvent(video(), new Event("loadeddata")));
    cleanup();
    const stop = reported.find((r) => r.kind === "stop")!.fields;
    expect(Object.keys((stop.diag as Record<string, unknown>) ?? {}).filter((k) => k.startsWith("resume"))).toEqual([]);
  });
});

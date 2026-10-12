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
  PlayerControls: (props: { currentSubtitleId?: number | null; onMenuChange?: (open: boolean) => void }) => (
    <div data-testid="commandes" data-subtitle={String(props.currentSubtitleId ?? "")}>
      {props.onMenuChange && <button onClick={() => props.onMenuChange!(true)}>menu:ouvrir</button>}
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
/** La préférence « lecteur serveur » du compte : vraie ici, sauf pour les tests de l'aiguillage (§78). */
let legacy = true;
vi.mock("@/lib/useLegacyPlayer", () => ({ useLegacyPlayer: () => ({ legacy }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
/** Le relais du lecteur natif, quand un test en simule un (version allégée, §78). */
let stableTakeover: Record<string, unknown> | null = null;
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: [], negotiating: false, reason: null, takeover: stableTakeover, stepAside: vi.fn(), stepBack: vi.fn(), returning: null }),
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
  usePlaybackSession: () => ({ stop: async () => {}, resume: () => {} }),
  stopOrphanSession: async () => {},
}));

/** L'instance hls.js simulée : ses écouteurs, et ce que le lecteur lui demande. */
type Listener = (event: string, data: Record<string, unknown>) => void;
const fake = {
  listeners: new Map<string, Listener[]>(),
  startLoad: vi.fn(),
  stopLoad: vi.fn(),
  recoverMediaError: vi.fn(),
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
    destroy() {}
  }
  return { default: Hls };
});

import { PlayerHost } from "@/components/PlayerHost";
import { carriedLighter, forgetLighterCarry, forgetLighters, noteLighter } from "@/lib/slowLinkPolicy";

const reponse: Record<string, unknown> & { playbackInfo: Record<string, unknown> & { video: Record<string, unknown> & { bitRate: number } }; subtitleTracks: unknown[] } = {
  playSessionId: "seance-jf",
  sourceBitrateBps: 16_000_000,
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
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
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
  playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film" };
  fake.listeners = new Map();
  fake.config = null;
  fake.stopLoad.mockClear();
  nativeHls = false;
  reported.length = 0;
  stableTakeover = null;
  legacy = true;
  forgetLighters();
  forgetLighterCarry();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("≈0,3 Mbit/s pour 3,9 demandés : la cause, nommée, avec ses chiffres", async () => {
    await mounted();
    await trickle(40_000, 21);
    expect(document.body.textContent).toContain("player.slowLink.failed");
    expect(document.body.textContent).not.toContain("player.loadingTooLong");
    const line = reported.find((r) => r.kind === "error")!.fields;
    expect(line).toMatchObject({ reason: "connexion trop lente", needMbps: 3.9, path: "serveur" });
    expect(line.recvMbps).toBeCloseTo(0.32, 1);
    expect(line.measuredS).toBeGreaterThanOrEqual(10);
  });

  it("le bilan `stop` porte le verdict du lien sous `diag`", async () => {
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
    noteLighter("film", { targetBps: 2_500_000, tier: 1 });
    await mounted();
    expect(startBodies[0]).toMatchObject({ maxBitrate: 2_500_000, lighter: true });
    expect(reported.find((r) => r.kind === "start")!.fields).toMatchObject({ lighterMbps: 2.5, lighterTier: 1 });
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
 * Dire la lenteur pendant le chargement et la lecture, sans jamais abandonner plus tôt (DECISIONS.md §78) :
 * l'indice, la fenêtre « Votre connexion semble lente » et ses choix, la version allégée palier par palier.
 */
describe("pendant le chargement : l'indice et la fenêtre (§78)", () => {
  const errors = () => reported.filter((r) => r.kind === "error");
  const popup = () => document.querySelector<HTMLElement>("[data-slow-link-popup]");
  const popupButtons = () => Array.from(popup()?.querySelectorAll("button") ?? []).map((b) => b.textContent);
  const popupButton = (label: string) => Array.from(popup()!.querySelectorAll("button")).find((b) => b.textContent === label)!;
  const negotiated = async (count: number) => {
    for (let i = 0; i < 50 && startBodies.length < count; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(startBodies).toHaveLength(count);
  };

  it("bon réseau : ni indice ni fenêtre — « trop long » à 20 s, comme avant", async () => {
    await mounted();
    const seen = await trickle(2_000_000, 21);
    expect(seen).not.toContain("player.slowLink.hint");
    expect(popup()).toBeNull();
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
  });

  it("A1 + A2 : ≈0,3 Mbit/s — l'indice dès 5 s, la fenêtre vers 10 s (Allégée · Réessayer · Fermer), puis l'écran à 20 s", async () => {
    await mounted();
    const seen = await trickle(40_000, 9);
    expect(seen.slice(0, 4)).not.toContain("player.slowLink.hint");
    expect(seen.slice(5)).toEqual(Array(4).fill("player.slowLink.hint"));
    await trickle(40_000, 3);
    expect(popup()!.textContent).toContain("player.slowLink.popup");
    expect(popup()!.textContent).not.toMatch(/\d/);
    expect(popupButtons()).toEqual(["player.slowLink.lighter", "common.retry", "common.close"]);
    expect(errors()).toHaveLength(0);
    expect(startBodies).toHaveLength(1);
    await trickle(40_000, 9);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("connexion trop lente");
    expect(document.body.textContent).toContain("player.slowLink.failed");
    // L'écran : Version allégée, Réessayer, Quitter.
    expect(screenLabels()).toEqual(expect.arrayContaining(["player.slowLink.lighter", "common.retry", "player.quit"]));
    cleanup();
    const stop = reported.find((r) => r.kind === "stop")!.fields;
    expect(stop.slowLink).toContain("fenêtre lente");
    expect(stop.slowChoice).toBe("aucun");
  });

  it("« Version allégée » : une négociation neuve au palier (moitié du mesuré, plancher 1,5), 720p au plus", async () => {
    reponse.playbackInfo.video.bitRate = 15_600_000;
    try {
      await mounted();
      // 2 Mbit/s reçus pour 16 demandés : palier 1 = 1,5 (moitié de 2 → 1, plancher).
      await trickle(250_000, 12);
      await act(async () => void fireEvent.click(popupButton("player.slowLink.lighter")));
      await negotiated(2);
      expect(startBodies[1]).toMatchObject({ maxBitrate: 1_500_000, lighter: true });
      const start = reported.filter((r) => r.kind === "start")[1].fields;
      expect(start).toMatchObject({ why: "lighter", lighterMbps: 1.5, lighterTier: 1 });
    } finally {
      reponse.playbackInfo.video.bitRate = 3_500_000;
    }
  });

  it("dégressif : la version allégée échoue encore — palier suivant ; au plancher, plus que Réessayer · Fermer", async () => {
    reponse.playbackInfo.video.bitRate = 15_600_000;
    try {
      // Un premier palier à 5 Mbit/s, déjà en cours ; le lien mesure 2 → max(1,5, min(2,5, 1)) = 1,5.
      noteLighter("film", { targetBps: 5_000_000, tier: 1 });
      await mounted();
      await trickle(250_000, 12);
      await act(async () => void fireEvent.click(popupButton("player.slowLink.lighter")));
      await negotiated(2);
      expect(startBodies[1]).toMatchObject({ maxBitrate: 1_500_000 });
      expect(reported.filter((r) => r.kind === "start")[1].fields).toMatchObject({ lighterTier: 2 });
    } finally {
      reponse.playbackInfo.video.bitRate = 3_500_000;
    }
    forgetLighters();
    cleanup();
    fake.config = null;
    noteLighter("film", { targetBps: 1_500_000, tier: 3 });
    await mounted();
    await trickle(40_000, 12);
    expect(popupButtons()).toEqual(["common.retry", "common.close"]);
  });

  it("A2 « Fermer » ferme la fenêtre seulement : le chargement continue, elle ne revient pas ; Retour fait de même", async () => {
    await mounted();
    await trickle(40_000, 12);
    await act(async () => void fireEvent.click(popupButton("common.close")));
    expect(popup()).toBeNull();
    await trickle(40_000, 3);
    expect(popup()).toBeNull();
    expect(playback.close).not.toHaveBeenCalled();
    expect(startBodies).toHaveLength(1);
    cleanup();
    reported.length = 0;
    fake.config = null;
    await mounted();
    await trickle(40_000, 12);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(popup()).toBeNull();
    expect(playback.close).not.toHaveBeenCalled();
  });

  it("A3 : ≈35 % — l'indice ; le chien de garde des 20 s rend le verdict, avec la version allégée", async () => {
    await mounted();
    const seen = await trickle(170_000, 19);
    expect(seen.slice(6)).toEqual(Array(13).fill("player.slowLink.hint"));
    expect(popup()).toBeNull();
    expect(errors()).toHaveLength(0);
    await trickle(170_000, 2);
    expect(errors()[0].fields.reason).toBe("connexion trop lente");
  });

  it("un débit qui remonte : l'indice se retire", async () => {
    await mounted();
    const seen = await trickle((t) => (t <= 7 ? 40_000 : 2_000_000), 12);
    expect(seen[6]).toBe("player.slowLink.hint");
    expect(seen.slice(8)).not.toContain("player.slowLink.hint");
    expect(errors()).toHaveLength(0);
  });

  it("C : hors ligne pendant le chargement — ni indice ni fenêtre, jamais d'allégée ; l'ancien « trop long »", async () => {
    await mounted();
    await trickle(40_000, 6);
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("offline")));
    try {
      await trickle(40_000, 15);
      expect(popup()).toBeNull();
      expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
      expect(document.body.textContent).not.toContain("player.slowLink.lighter");
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
    expect(popup()).toBeNull();
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
    expect(document.body.textContent).toContain("player.loadingTooLong");
  });

  it("version allégée non permise au compte (politique Jellyfin) : Réessayer · Fermer", async () => {
    reponse.lighterAllowed = false;
    try {
      await mounted();
      await trickle(40_000, 12);
      expect(popupButtons()).toEqual(["common.retry", "common.close"]);
    } finally {
      delete reponse.lighterAllowed;
    }
  });
});

/** Les libellés des boutons de l'écran d'erreur du lecteur serveur. */
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
      stableTakeover = { resumeAt: 600, lighter: true, subtitleStreamIndex: 7, subtitleGenerating: true, owner: playback.session };
      noteLighter("film", { targetBps: 1_500_000, tier: 1 });
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
    legacy = false;
    render(<PlayerHost />);
    expect(document.querySelector("[data-testid=natif]")).not.toBeNull();
    cleanup();
    playback.session = { itemId: "film", openId: 2, resumeAt: 0, title: "Film", lighter: { targetBps: 2_500_000, tier: 1 } };
    render(<PlayerHost />);
    expect(document.querySelector("[data-testid=natif]")).toBeNull();
    cleanup();
    playback.session = { itemId: "film", openId: 3, resumeAt: 0, title: "Film" };
    stableTakeover = { resumeAt: 0, lighter: true, owner: playback.session };
    render(<PlayerHost />);
    expect(document.querySelector("[data-testid=natif]")).toBeNull();
  });

  it("moins de 2 min après une séance allégée : la lecture part directement au palier hérité (`lighterCarried`)", async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film", lighter: { targetBps: 2_500_000, tier: 1 } };
    await mounted();
    expect(startBodies[0]).toMatchObject({ maxBitrate: 2_500_000, lighter: true });
    expect(reported.find((r) => r.kind === "start")!.fields).toMatchObject({ lighterCarried: true, lighterTier: 1 });
  });

  it("une séance allégée qui s'arrête est retenue deux minutes", async () => {
    noteLighter("film", { targetBps: 2_500_000, tier: 1 });
    await mounted();
    await picture();
    cleanup();
    expect(carriedLighter()).toEqual({ targetBps: 2_500_000, tier: 1 });
  });

  it("le lien à 115 % du besoin classique pendant 10 s : la mémoire s'efface — la lecture suivante sera native", async () => {
    noteLighter("film", { targetBps: 2_500_000, tier: 1 });
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
    noteLighter("film", { targetBps: 2_500_000, tier: 1 });
    await mounted();
    await picture();
    await flow(2_000_000, 30);
    cleanup();
    expect(carriedLighter()).toEqual({ targetBps: 2_500_000, tier: 1 });
  });

  it("B : un blocage réseau de plus de 5 s pendant la lecture — la fenêtre des saccades ; jamais sous un menu ouvert", async () => {
    await mounted();
    await picture();
    await act(async () => void fireEvent(video(), new Event("waiting")));
    await trickle(250_000, 6);
    const popup = document.querySelector("[data-slow-link-popup]");
    expect(popup?.textContent).toContain("player.slowLink.popupStutter");
    expect(Array.from(popup!.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["player.slowLink.lighter", "common.close"]);
    // Pas d'erreur : la lecture continue.
    expect(reported.filter((r) => r.kind === "error")).toHaveLength(0);
    await act(async () => void fireEvent.click(document.querySelector("[data-testid=commandes] button")!));
    expect(document.querySelector("[data-slow-link-popup]")).toBeNull();
  });
});

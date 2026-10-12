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
import { forgetSlowLinks, noteSlowLink, slowLinkVerdict } from "@/lib/slowLink";

const reponse = {
  playSessionId: "seance-jf",
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
  forgetSlowLinks();
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
    expect(document.body.textContent).toContain("player.slowLink.message");
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

  it("abaissé pour le titre dont le lecteur natif vient de mesurer la lenteur", async () => {
    noteSlowLink("film", slowLinkVerdict({ bytes: (1_800_000 * 20) / 8, receivingMs: 20_000 }, 3_900_000)!);
    await mounted();
    expect(startBodies[0].maxBitrate).toBe(1_500_000);
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
 * Dire la lenteur pendant le chargement, sans jamais abandonner plus tôt (DECISIONS.md §77,
 * 12/10/2026) : l'indice, puis le message chiffré et ses choix ; le chien de garde des 20 s seul renonce.
 */
describe("pendant le chargement : l'indice et le message chiffré", () => {
  const errors = () => reported.filter((r) => r.kind === "error");
  const notice = () => document.querySelector<HTMLElement>("[data-playback-intro-notice]");
  const noticeButton = (label: string) => Array.from(notice()!.querySelectorAll("button")).find((b) => b.textContent === label);

  it("un bon lien : ni indice ni message — « trop long » à 20 s, comme avant", async () => {
    await mounted();
    const seen = await trickle(2_000_000, 21);
    expect(seen).not.toContain("player.slowLink.hint");
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
  });

  it("≈0,3 Mbit/s : l'indice dès 5 s, le message chiffré vers 10 s sans « Version allégée », le renoncement à 20 s inchangé", async () => {
    await mounted();
    const seen = await trickle(40_000, 9);
    expect(seen.slice(0, 4)).not.toContain("player.slowLink.hint");
    expect(seen.slice(5)).toEqual(Array(4).fill("player.slowLink.hint"));
    await trickle(40_000, 3);
    expect(notice()?.textContent).toContain("player.slowLink.notice");
    expect(noticeButton("player.slowLink.lighter")).toBeUndefined();
    expect(noticeButton("common.close")).toBeTruthy();
    // Rien d'abandonné : pas de ligne, une seule négociation.
    expect(errors()).toHaveLength(0);
    expect(startBodies).toHaveLength(1);
    await trickle(40_000, 9);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("connexion trop lente");
    expect(document.body.textContent).toContain("player.slowLink.message");
    cleanup();
    const stop = reported.find((r) => r.kind === "stop")!.fields;
    expect(stop.slowNoticeAt).toBeTypeOf("number");
    expect(stop.slowChoice).toBeNull();
  });

  it("« Version allégée » : une négociation neuve, au débit que le lien porte", async () => {
    // 16 Mbit/s demandés ; 2 Mbit/s reçus — sous le quart, au-dessus du plancher.
    reponse.playbackInfo.video.bitRate = 15_600_000;
    try {
      await mounted();
      await trickle(250_000, 12);
      expect(errors()).toHaveLength(0);
      await act(async () => void fireEvent.click(noticeButton("player.slowLink.lighter")!));
      for (let i = 0; i < 50 && startBodies.length < 2; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(startBodies).toHaveLength(2);
      expect(startBodies[1].maxBitrate as number).toBeLessThan(2_000_000);
      expect(startBodies[1].maxBitrate as number).toBeGreaterThanOrEqual(1_500_000);
      const start = reported.filter((r) => r.kind === "start")[1].fields;
      expect(start.why).toBe("lighter");
    } finally {
      reponse.playbackInfo.video.bitRate = 3_500_000;
    }
  });

  it("« Fermer » : la fermeture ordinaire, le choix noté au bilan", async () => {
    await mounted();
    await trickle(40_000, 12);
    await act(async () => void fireEvent.click(noticeButton("common.close")!));
    const stop = reported.find((r) => r.kind === "stop")!.fields;
    expect(stop).toMatchObject({ why: "close", slowChoice: "fermer" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    expect(playback.close).toHaveBeenCalled();
  });

  it("≈35 % du besoin : l'indice, pas de message", async () => {
    await mounted();
    const seen = await trickle(170_000, 19);
    expect(seen.slice(6)).toEqual(Array(13).fill("player.slowLink.hint"));
    expect(notice()).toBeNull();
    expect(errors()).toHaveLength(0);
  });

  it("un débit qui remonte : l'indice se retire", async () => {
    await mounted();
    const seen = await trickle((t) => (t <= 7 ? 40_000 : 2_000_000), 12);
    expect(seen[6]).toBe("player.slowLink.hint");
    expect(seen.slice(8)).not.toContain("player.slowLink.hint");
    expect(errors()).toHaveLength(0);
  });

  it("Safari (HLS natif, rien de mesuré) : rien ne change", async () => {
    nativeHls = true;
    render(<PlayerHost />);
    const seen: (string | null)[] = [];
    for (let t = 0; t < 21; t++) {
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
      seen.push(introNote());
    }
    expect(seen).not.toContain("player.slowLink.hint");
    expect(notice()).toBeNull();
    expect(errors()).toHaveLength(1);
    expect(errors()[0].fields.reason).toBe("pas de première image en 20 s");
    expect(document.body.textContent).toContain("player.loadingTooLong");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PlaybackTimeline,
  TIMELINE_EVERY_MS,
  TIMELINE_KEEP,
  TIMELINE_MAX_CHARS,
  clearTimelines,
  parseTimeline,
  registerTimeline,
  timelineFields,
  type TimelineSample,
} from "@/lib/playbackTimeline";
import { ServerStartup } from "@/lib/serverStartup";

// La chronologie des deux dernières minutes (DECISIONS.md §77) : un échantillon toutes les 5 s, en
// mémoire, joint aux lignes de panne et au bilan — jamais une ligne de plus.

function fakeSampler() {
  let pos = 1000;
  return () => {
    pos += 5;
    return { pos, recvMbps: 2.1, aheadS: 12.46, reserveMB: 37.4, state: "L" as const } satisfies Omit<TimelineSample, "wall">;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearTimelines();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("l'échantillonnage", () => {
  it("toutes les 5 s, dans un anneau borné à deux minutes", () => {
    const timeline = new PlaybackTimeline(fakeSampler()).start();
    vi.advanceTimersByTime(60_000);
    expect(timeline.samples()).toHaveLength(60_000 / TIMELINE_EVERY_MS);
    vi.advanceTimersByTime(600_000);
    expect(timeline.samples()).toHaveLength(TIMELINE_KEEP);
    // Les plus récents restent.
    expect(timeline.samples().at(-1)!.wall).toBe(660_000);
    timeline.stop();
    vi.advanceTimersByTime(60_000);
    expect(timeline.samples().at(-1)!.wall).toBe(660_000);
  });

  it("forme compacte : position, secondes, Mb/s, tampon, réserve, état — relue à l'identique", () => {
    const timeline = new PlaybackTimeline(fakeSampler()).start();
    vi.advanceTimersByTime(10_000);
    expect(timeline.compact()).toBe("1005,5,2.1,12.5,37,L;1010,10,2.1,12.5,37,L");
    expect(parseTimeline(timeline.compact())).toEqual([
      { pos: 1005, wall: 5000, recvMbps: 2.1, aheadS: 12.5, reserveMB: 37, state: "L" },
      { pos: 1010, wall: 10_000, recvMbps: 2.1, aheadS: 12.5, reserveMB: 37, state: "L" },
    ]);
    // L'inconnu s'écrit « - » et se relit `null` ; un morceau illisible est ignoré.
    expect(parseTimeline("12,5,-,-,-,A;n'importe quoi")).toEqual([{ pos: 12, wall: 5000, recvMbps: null, aheadS: null, reserveMB: null, state: "A" }]);
  });

  it("un anneau plein tient dans son plafond", () => {
    const timeline = new PlaybackTimeline(() => ({ pos: 123456.7, recvMbps: 123.4, aheadS: 123.4, reserveMB: 499, state: "A" })).start();
    vi.advanceTimersByTime(TIMELINE_EVERY_MS * 100);
    expect(timeline.compact().length).toBeLessThanOrEqual(TIMELINE_MAX_CHARS);
    expect(parseTimeline(timeline.compact()).length).toBeGreaterThan(20);
  });

  it("un échantillonneur qui lève ne fait qu'un échantillon de moins", () => {
    const timeline = new PlaybackTimeline(() => {
      throw new Error("boum");
    }).start();
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();
    expect(timeline.samples()).toHaveLength(0);
  });
});

describe("la jointure aux lignes", () => {
  it("sur les lignes de panne et le bilan, pas sur les autres, et seulement pour sa séance", () => {
    const timeline = new PlaybackTimeline(fakeSampler()).start();
    const unregister = registerTimeline("s1", timeline);
    vi.advanceTimersByTime(10_000);
    for (const kind of ["stall", "error", "fallback", "rebuild", "network", "stop"]) {
      expect(timelineFields(kind, { session: "s1" }).timeline).toBeTypeOf("string");
    }
    for (const kind of ["start", "seek", "audio", "reserve", "opening"]) expect(timelineFields(kind, { session: "s1" })).toEqual({});
    expect(timelineFields("stall", { session: "autre" })).toEqual({});
    expect(timelineFields("stall", {})).toEqual({});
    // Un dernier échantillon pris à l'instant de la ligne : la panne elle-même y figure.
    expect(parseTimeline(timelineFields("stall", { session: "s1" }).timeline).length).toBeGreaterThanOrEqual(3);
    unregister();
    expect(timelineFields("stall", { session: "s1" })).toEqual({});
  });

  it("le relais : le lecteur serveur inscrit le sien sous la même séance, chacun ne retire que le sien", () => {
    const native = new PlaybackTimeline(() => ({ pos: 1, recvMbps: 1, aheadS: 1, reserveMB: 1, state: "L" }));
    const server = new PlaybackTimeline(() => ({ pos: 2, recvMbps: null, aheadS: 2, reserveMB: null, state: "A" }));
    const offNative = registerTimeline("s", native);
    registerTimeline("s", server);
    offNative();
    expect(timelineFields("error", { session: "s" }).timeline).toBe("2,0,-,2,-,A");
  });

  it("reportPlayback l'emporte sur la ligne, et aucune ligne ne part pour l'anneau lui-même", async () => {
    const sent: { url: string; body: { kind: string; fields: Record<string, unknown> } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200 };
      })
    );
    vi.stubGlobal("navigator", { userAgent: "test", sendBeacon: undefined });
    const { reportPlayback } = await import("@/lib/reportPlayback");
    const timeline = new PlaybackTimeline(fakeSampler()).start();
    registerTimeline("s9", timeline);
    // Deux minutes de lecture ordinaire : rien ne part.
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(0);
    reportPlayback("seek", { session: "s9" });
    reportPlayback("stall", { session: "s9", position: 1100 });
    expect(sent[0].body.fields.timeline).toBeUndefined();
    expect(parseTimeline(sent[1].body.fields.timeline)).toHaveLength(TIMELINE_KEEP);
    timeline.stop();
  });

  it("la route la garde hors du plafond de quarante champs, bornée à part", async () => {
    vi.useRealTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-log-"));
    vi.resetModules();
    vi.doMock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
    try {
      const { logPlaybackEvent } = await import("@/lib/playerLog");
      const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, i]));
      const ring = Array.from({ length: 24 }, (_, i) => `${1000 + i * 5},${i * 5},2.1,12.5,37,L`).join(";");
      logPlaybackEvent("louis", "stop", { ...many, timeline: ring });
      logPlaybackEvent("louis", "stall", { timeline: "x".repeat(5000) });
      const lines = fs.readFileSync(path.join(dir, "logs", "player.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines[0].timeline).toBe(ring);
      expect(Object.keys(lines[0]).filter((k) => k.startsWith("f"))).toHaveLength(40);
      expect(lines[1].timeline.length).toBe(TIMELINE_MAX_CHARS);
    } finally {
      vi.doUnmock("@/lib/dataDir");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("le démarrage du lecteur serveur", () => {
  it("hls.js : listes, segment demandé, reçu (octets, débit), tampon, image — et l'étape atteinte", () => {
    let clock = 1000;
    const s = new ServerStartup(1000, () => clock);
    expect(s.stage()).toBe("liste");
    clock = 1300;
    s.negotiated();
    s.master({ loaded: 120_000, loading: { start: 1310, first: 1400, end: 1500 } });
    expect(s.stage()).toBe("liste");
    s.variant({ loaded: 920_000, loading: { start: 1510, first: 1600, end: 24_000 } });
    expect(s.stage()).toBe("segment");
    clock = 24_100;
    s.fragAsked();
    s.fragLoaded({ loaded: 3_000_000, loading: { start: 24_100, first: 24_200, end: 30_200 } });
    expect(s.stage()).toBe("décodage");
    clock = 30_300;
    s.buffered();
    expect(s.stage()).toBe("image");
    expect(s.fields(true)).toEqual({
      startup: {
        negotiateMs: 300,
        masterMs: 500,
        masterKB: 120,
        variantMs: 23_000,
        variantKB: 920,
        fragAskedMs: 23_100,
        fragMs: 29_200,
        fragKB: 3000,
        fragMbps: 4,
        bufferedMs: 29_300,
        stage: "image",
      },
    });
    // La première fois seulement.
    s.master({ loaded: 1, loading: { end: 99_999 } });
    expect((s.fields().startup as Record<string, number>).masterKB).toBe(120);
  });

  it("Safari : les entrées de ressources du flux, au mieux", () => {
    const s = new ServerStartup(1000, () => 5000);
    const entry = (name: string, startTime: number, responseEnd: number, size: number) =>
      ({ name, startTime, responseStart: startTime + 50, responseEnd, encodedBodySize: size, transferSize: size + 300 }) as unknown as PerformanceEntry;
    s.fromResources(
      [
        entry("https://cine.example/api/jellyfin/stream/x/master.m3u8?sig=1", 1100, 1400, 2000),
        entry("https://cine.example/api/jellyfin/stream/x/main.m3u8?sig=1", 1450, 2000, 90_000),
        entry("https://cine.example/api/jellyfin/stream/x/hls1/main/0.mp4?sig=1", 2100, 4100, 1_000_000),
        entry("https://cine.example/_next/static/chunk.js", 1200, 1300, 5),
        entry("https://cine.example/api/jellyfin/stream/x/vieux.m3u8", 900, 950, 1),
      ],
      "/api/jellyfin/stream/"
    );
    expect(s.fields(true).startup).toMatchObject({ masterMs: 400, masterKB: 2, variantMs: 1000, variantKB: 90, fragAskedMs: 1100, fragMs: 3100, fragKB: 1000, stage: "décodage" });
  });

  it("ne lève jamais", () => {
    const s = new ServerStartup(0);
    expect(() => s.fromResources([{ name: 42 } as unknown as PerformanceEntry], "/x")).not.toThrow();
    expect(() => s.fragLoaded(undefined)).not.toThrow();
  });
});

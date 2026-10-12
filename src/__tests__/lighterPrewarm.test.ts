// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Le préchauffage de la version allégée (DECISIONS.md §78) : la négociation et le premier segment en
// arrière-plan ; repris tel quel par le lecteur serveur, ou arrêté chez Jellyfin s'il ne sert pas.

vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({ video: { "mp4/hevc10": true }, audio: {} }) }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => false }));

import { cancelPrewarm, forgetPrewarm, prewarmFields, segmentAt, startPrewarm, takePrewarm } from "@/lib/lighterPrewarm";

const START = {
  playSessionId: "ps-1",
  mediaSourceId: "ms-1",
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8?DeviceId=dev-1&MediaSourceId=ms-1&PlaySessionId=ps-1",
  isDirectPlay: false,
};
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="hvc1.1.4.L120.B0,mp4a.40.2"\nmain.m3u8?a=1\n';
const VARIANT = "#EXTM3U\n" + Array.from({ length: 500 }, (_, i) => `#EXTINF:3.003,\nhls1/main/${i}.mp4?x=1`).join("\n") + "\n#EXT-X-ENDLIST\n";

let calls: { url: string; body?: Record<string, unknown> }[] = [];
beforeEach(() => {
  forgetPrewarm();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url) === "/api/jellyfin/playback/start") return { ok: true, status: 200, json: async () => START };
      if (String(url).includes("master.m3u8")) return { ok: true, text: async () => MASTER };
      if (String(url).includes("main.m3u8")) return { ok: true, text: async () => VARIANT };
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10), json: async () => ({}) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("le préchauffage", () => {
  it("le segment qui contient la position, d'après les #EXTINF cumulés", () => {
    expect(segmentAt(VARIANT, "http://x/v/main.m3u8", 1200)).toMatchObject({ index: 399, url: "http://x/v/hls1/main/399.mp4?x=1" });
    expect(segmentAt(VARIANT, "http://x/v/main.m3u8", 0)?.index).toBe(0);
  });

  it("négocie sans annoncer (`prewarm: true`), au palier, puis demande maître, variante et LE segment de la position", async () => {
    const prewarm = startPrewarm({ itemId: "film", step: { targetBps: 1_500_000, tier: 1 }, startSeconds: 1200, audioStreamIndex: 2 });
    expect(await prewarm.ready).toBe(true);
    expect(calls[0].body).toMatchObject({ itemId: "film", maxBitrate: 1_500_000, lighter: true, prewarm: true, audioStreamIndex: 2, startTicks: 1200 * 10_000_000 });
    expect(calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ""))).toEqual([
      "/api/jellyfin/playback/start",
      "/api/jellyfin/stream/film/master.m3u8?DeviceId=dev-1&MediaSourceId=ms-1&PlaySessionId=ps-1",
      "/api/jellyfin/stream/film/main.m3u8?a=1",
      "/api/jellyfin/stream/film/hls1/main/399.mp4?x=1",
    ]);
    expect(prewarmFields(prewarm)).toMatchObject({ mbps: 1.5, tier: 1, state: "ready", res: "1280x720", segment: 399 });
  });

  it("repris une seule fois, par le titre préchauffé — la même réponse de négociation", async () => {
    const prewarm = startPrewarm({ itemId: "film", step: { targetBps: 1_500_000, tier: 1 }, startSeconds: 0 });
    await prewarm.ready;
    expect(takePrewarm("autre")).toBeNull();
    const taken = takePrewarm("film");
    expect(taken?.data?.playSessionId).toBe("ps-1");
    expect(takePrewarm("film")).toBeNull();
  });

  it("abandonné : le transcodage est arrêté chez Jellyfin (appareil et séance lus dans l'adresse), sans position écrite", async () => {
    const prewarm = startPrewarm({ itemId: "film", step: { targetBps: 1_500_000, tier: 1 }, startSeconds: 0 });
    await prewarm.ready;
    cancelPrewarm(prewarm);
    await Promise.resolve();
    const stop = calls.find((c) => c.url === "/api/jellyfin/playback/stop");
    expect(stop?.body).toEqual({ itemId: "film", playSessionId: "ps-1", mediaSourceId: "ms-1", deviceId: "dev-1", prewarm: true });
    expect(takePrewarm("film")).toBeNull();
  });

  it("une négociation refusée : en échec, sans rien lever (la bascule négociera elle-même)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    const prewarm = startPrewarm({ itemId: "film", step: { targetBps: 1_500_000, tier: 1 }, startSeconds: 0 });
    expect(await prewarm.ready).toBe(false);
    expect(prewarm.state).toBe("failed");
  });
});

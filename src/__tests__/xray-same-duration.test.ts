import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Un fichier remplacé à durée égale (± 1 s) garde son analyse (consigne du propriétaire, 09/11/2026 ;
 * DECISIONS.md §138) : le lecteur sert les scènes de l'ancien `ETag` au lieu de répondre `stale`, et la
 * commande d'une séance demande au service de rattacher le résultat plutôt que de tout réanalyser.
 */

const ITEM = "d".repeat(32);

const svc = vi.hoisted(() => ({
  scenes: null as unknown,
  status: null as unknown,
  enqueued: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => true,
  xray: {
    scenes: async () => svc.scenes,
    itemStatus: async () => svc.status,
    enqueue: async (job: Record<string, unknown>) => {
      svc.enqueued.push(job);
      return { itemId: job.itemId, status: job.rebindIfSameDuration ? "done" : "queued", position: 1 };
    },
  },
}));
const target = vi.hoisted(() => ({ etag: "v2", durationS: 2551.4 as number | null }));
vi.mock("@/lib/xray/cast", () => ({
  analysisTarget: async (itemId: string) => ({ itemId, type: "Episode", path: "/media/m.mkv", etag: target.etag, seriesId: null, tmdb: { kind: "episode", tvId: 1, season: 1, episode: 1 }, durationS: target.durationS }),
  castOf: async () => [{ personId: 7, name: "Lucas Till", character: "Angus MacGyver", order: 0, profilePath: "/lt.jpg" }],
  castWithPhotos: async () => [{ personId: 7, name: "Lucas Till", character: "Angus MacGyver", order: 0, photos: [] }],
  tmdbPhotoUrl: (p: string) => `https://image.tmdb.org/t/p/w185${p}`,
  nextEpisodeAfter: () => null,
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/taskLog", () => ({ taskLog: vi.fn() }));

import { scenesForPlayer } from "@/lib/xray/scenes";
import { forgetXrayOrders, orderAnalysis } from "@/lib/xray/orders";
import { recordedDuration, recordFileVersion } from "@/lib/xray/scanStore";

const RESULT = {
  itemId: ITEM,
  etag: "v1",
  model: "m",
  version: 1,
  complete: true,
  analyzedUntil: 2551,
  scenes: [{ start: 10, end: 20, people: [{ personId: 7, screenTime: 8, confidence: 0.9 }] }],
};

beforeEach(() => {
  Object.assign(svc, { scenes: RESULT, status: { itemId: ITEM, etag: "v1", status: "done", progress: 1, analyzedUntil: 2551, error: null, durationS: 2551.0 }, enqueued: [] });
  Object.assign(target, { etag: "v2", durationS: 2551.4 });
  forgetXrayOrders();
});

describe("le lecteur", () => {
  it("sert les scènes d'un autre ETag quand la durée est la même", async () => {
    const body = await scenesForPlayer(ITEM);
    expect(body.status).toBe("done");
    expect(body.scenes[0].people[0]).toMatchObject({ personId: 7, name: "Lucas Till" });
  });

  it("répond `stale` quand la durée a changé", async () => {
    target.durationS = 2700;
    expect((await scenesForPlayer(ITEM)).status).toBe("stale");
  });

  it("sans durée du service, la durée retenue à la commande fait foi", async () => {
    svc.status = { itemId: ITEM, etag: "v1", status: "done", progress: 1, analyzedUntil: 0, error: null };
    svc.scenes = { ...RESULT, analyzedUntil: 0 };
    expect((await scenesForPlayer(ITEM)).status).toBe("stale");
    recordFileVersion(ITEM, "v1", 2551.9);
    expect((await scenesForPlayer(ITEM)).status).toBe("done");
  });

  it("une durée inconnue du fichier présent ne garde rien", async () => {
    target.durationS = null;
    expect((await scenesForPlayer(ITEM)).status).toBe("stale");
  });
});

describe("la commande d'une séance", () => {
  it("demande le rattachement au lieu de réanalyser", async () => {
    const outcome = await orderAnalysis(ITEM, { priority: "high" });
    expect(outcome).toMatchObject({ status: "ordered", answer: { status: "done" } });
    expect(svc.enqueued).toHaveLength(1);
    expect(svc.enqueued[0]).toMatchObject({ etag: "v2", rebindIfSameDuration: true, durationS: 2551.4 });
  });

  it("une durée différente : commandée normalement, et la durée de cette version retenue", async () => {
    target.durationS = 2700;
    const other = "e".repeat(32);
    await orderAnalysis(other, { priority: "high" });
    expect(svc.enqueued).toHaveLength(1);
    expect(svc.enqueued[0].rebindIfSameDuration).toBeUndefined();
    expect(recordedDuration(other, "v2")).toBe(2700);
  });
});

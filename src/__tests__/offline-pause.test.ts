import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * La pause d'un téléchargement (Louis, 19/10/2026) : plus rien n'arrive sur l'appareil, un pas de la
 * boucle déjà parti ne défait pas la pause, et la reprise relance le téléchargement là où il était.
 */

const metas = new Map<string, OfflineDownload>();
const removed: string[] = [];

vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "acc" }));
vi.mock("@/lib/reportClientError", () => ({ reportClientError: vi.fn() }));
vi.mock("@/lib/unsentPosition", () => ({ saveUnsentPosition: vi.fn(), flushUnsentPositions: vi.fn(async () => {}) }));
vi.mock("@/lib/offline/deviceStore", () => ({
  deviceStoreSupported: () => true,
  resetDeviceStore: vi.fn(),
  deviceStore: {
    list: async () => [...metas.keys()],
    readMeta: async (_account: string, id: string) => metas.get(id) ?? null,
    videoSize: async (_account: string, id: string) => metas.get(id)?.bytes ?? 0,
    writeMeta: async (_account: string, id: string, meta: OfflineDownload) => void metas.set(id, meta),
    remove: async (_account: string, id: string) => {
      removed.push(id);
      metas.delete(id);
    },
    truncateVideo: async () => {},
    writeVideo: async () => {},
    writePoster: async () => {},
  },
}));


const film = (change: Partial<OfflineDownload>): OfflineDownload =>
  ({
    id: "f1",
    itemId: "item-f1",
    radarrId: 1,
    title: "Un film",
    year: null,
    runtimeSeconds: 6000,
    quality: "standard",
    codec: "hevc",
    audioIndex: 1,
    audioLabel: "Français",
    audioTracks: [],
    generation: 1,
    expectedBytes: 100,
    serverBytes: 0,
    serverDone: false,
    bytes: 0,
    state: "preparing",
    error: null,
    createdAt: 1,
    positionSeconds: 0,
    hasPoster: false,
    ...change,
  }) as OfflineDownload;

let jobBytes = 0;
beforeEach(() => {
  vi.resetModules();
  metas.clear();
  removed.length = 0;
  jobBytes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/file")) return new Response(new Uint8Array(0), { status: 416 });
      return new Response(JSON.stringify({ job: { id: "f1", status: "running", bytes: jobBytes, expectedBytes: 100, generation: 1, runtimeSeconds: 6000 } }), { status: 200 });
    })
  );
});

describe("pause", () => {
  it("met en pause, reste en pause malgré la boucle, et reprend", async () => {
    metas.set("f1", film({}));
    const m = await import("@/lib/offline/downloads");
    await m.initOfflineDownloads();
    await m.pauseOfflineDownload("f1");
    expect(m.offlineDownloadById("f1")?.state).toBe("paused");
    expect(metas.get("f1")?.state).toBe("paused");
    // La boucle tourne encore un moment : rien ne repasse en téléchargement tout seul.
    await new Promise((r) => setTimeout(r, 50));
    expect(m.offlineDownloadById("f1")?.state).toBe("paused");
    await m.resumeOfflineDownload("f1");
    expect(m.offlineDownloadById("f1")?.state).toBe("preparing");
    expect(metas.get("f1")?.fromUser).toBeUndefined();
  });

  it("une pause ne concerne pas un téléchargement fini", async () => {
    metas.set("f1", film({ state: "done", bytes: 100, serverDone: true }));
    const m = await import("@/lib/offline/downloads");
    await m.initOfflineDownloads();
    await m.pauseOfflineDownload("f1");
    expect(m.offlineDownloadById("f1")?.state).toBe("done");
  });
});

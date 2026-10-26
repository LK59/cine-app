import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * Une session refusée (401) arrête les téléchargements jusqu'au prochain chargement (26/10/2026) : ils
 * réessayaient toutes les 60 s sans fin sur l'ancienne adresse d'un iPhone.
 */

const metas = new Map<string, OfflineDownload>();
const removed: string[] = [];

vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "acc" }));
vi.mock("@/lib/reportClientError", () => ({ reportClientError: vi.fn() }));
vi.mock("@/lib/unsentPosition", () => ({ saveUnsentPosition: vi.fn(), flushUnsentPositions: vi.fn(async () => {}) }));
vi.mock("@/lib/offline/deviceStore", () => ({
  deviceStoreSupported: () => true,
  isDeviceStoreError: () => false,
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

let statusCalls = 0;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  metas.clear();
  removed.length = 0;
  statusCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/offline/jobs/")) statusCalls += 1;
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    })
  );
});

describe("session refusée", () => {
  it("un refus arrête la boucle : plus aucune demande, même dix minutes plus tard", async () => {
    metas.set("f1", film({}));
    const m = await import("@/lib/offline/downloads");
    await m.initOfflineDownloads();
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(statusCalls).toBe(1);
    // Rien de perdu : le téléchargement attend, tel quel.
    expect(m.offlineDownloadById("f1")?.state).toBe("preparing");
    expect(removed).toEqual([]);
    vi.useRealTimers();
  });

  it("une autre erreur (serveur qui redémarre) réessaie comme avant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/offline/jobs/")) statusCalls += 1;
        return new Response("", { status: 502 });
      })
    );
    metas.set("f1", film({}));
    const m = await import("@/lib/offline/downloads");
    await m.initOfflineDownloads();
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    await vi.advanceTimersByTimeAsync(5_100);
    expect(statusCalls).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});

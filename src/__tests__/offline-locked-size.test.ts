import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * Un fichier tenu un instant par une autre page (le rechargement d'une nouvelle version, iPhone,
 * 19/10/2026) : sa taille ne se lit pas. Le téléchargement garde la taille notée au dernier morceau,
 * au lieu de 0 — un épisode entier s'affichait « 0 Mo » et ne se lisait plus.
 */

const metas = new Map<string, OfflineDownload>();
const removed: string[] = [];
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "acc" }));
vi.mock("@/lib/reportClientError", () => ({ reportClientError: vi.fn() }));
vi.mock("@/lib/offline/deviceStore", () => ({
  deviceStoreSupported: () => true,
  isDeviceStoreError: () => false,
  resetDeviceStore: vi.fn(),
  deviceStore: {
    list: async () => [...metas.keys(), "orphelin-video", "orphelin-vide"],
    readMeta: async (_a: string, id: string) => metas.get(id) ?? null,
    files: async (_a: string, id: string) => (id === "orphelin-video" ? ["video.mp4"] : []),
    videoSize: async () => {
      throw Object.assign(new Error("InvalidStateError: The object is in an invalid state."), { deviceStore: true });
    },
    writeMeta: async () => {},
    remove: async (_a: string, id: string) => void removed.push(id),
  },
}));

beforeEach(() => {
  metas.clear();
  removed.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
});

describe("taille illisible au chargement", () => {
  it("garde la taille notée, et n'efface jamais un dossier qui a une vidéo", async () => {
    metas.set("ep", {
      id: "ep",
      itemId: "item",
      radarrId: null,
      title: "Une série — S01E05",
      year: null,
      runtimeSeconds: 1866,
      quality: "standard",
      codec: "hevc",
      audioIndex: 1,
      audioLabel: "Français",
      audioTracks: [],
      generation: 1,
      expectedBytes: 469_160_907,
      serverBytes: 469_160_907,
      serverDone: true,
      bytes: 469_160_907,
      state: "done",
      error: null,
      createdAt: 1,
      positionSeconds: 0,
      hasPoster: false,
      trickplay: null,
      artwork: null,
    });
    const m = await import("@/lib/offline/downloads");
    await m.initOfflineDownloads();
    expect(m.offlineDownloadById("ep")?.bytes).toBe(469_160_907);
    await new Promise((r) => setTimeout(r, 0));
    expect(removed).toEqual(["orphelin-vide"]);
  });
});

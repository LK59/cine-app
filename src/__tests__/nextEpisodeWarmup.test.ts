import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  close: vi.fn(),
  open: vi.fn(),
  openMediaFile: vi.fn(async () => ({ tracks: [] })),
  preload: vi.fn(async () => ({ streamUrl: "/api/jellyfin/stream/next/stream.mkv?static=true", sizeBytes: 1234, fileVersion: "etag-1" as string | undefined })),
  prefetchState: vi.fn(),
  recordTitle: vi.fn(async () => 18),
  openDisk: vi.fn(async () => null as unknown),
  account: "louis" as string | null,
}));
vi.mock("@/lib/webcodecs/byteSource", () => ({
  HttpByteSource: { open: (...a: unknown[]) => h.open(...a) },
}));
vi.mock("@/lib/webcodecs/mediaFile", async (importOriginal) => ({
  mediaHeaderKey: (await importOriginal<typeof import("@/lib/webcodecs/mediaFile")>()).mediaHeaderKey,
  openMediaFile: (...a: unknown[]) => h.openMediaFile(...(a as [])),
}));
vi.mock("@/lib/prefetch", () => ({ preloadQuietly: () => h.preload() }));
vi.mock("@/lib/playbackPrefetch", () => ({
  directInfoKey: (id: string) => `/api/jellyfin/direct/${id}`,
  prefetchPlaybackState: (id: string) => h.prefetchState(id),
}));

vi.mock("@/lib/resumeCache/recordTitle", () => ({ recordTitle: (...a: unknown[]) => h.recordTitle(...(a as [])) }));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => h.account }));
vi.mock("@/lib/resumeCache/diskChunks", () => ({ openDiskChunks: (...a: unknown[]) => h.openDisk(...(a as [])) }));

import { warmNextEpisode } from "@/lib/nextEpisodeWarmup";

beforeEach(() => {
  vi.clearAllMocks();
  h.account = "louis";
  h.open.mockImplementation(async () => {
    const source = { close: h.close, withoutReadahead: vi.fn(() => source) };
    return source;
  });
});

describe("warmNextEpisode", () => {
  it("prépare la position, la description et l'en-tête, sous l'adresse que l'ouverture lira", async () => {
    await warmNextEpisode("ep-2");
    expect(h.prefetchState).toHaveBeenCalledWith("ep-2");
    expect(h.open).toHaveBeenCalledWith("/api/jellyfin/stream/next/stream.mkv?static=true", 1234, null);
    // Adresse et version du fichier, comme l'ouverture les nomme (`mediaHeaderKey`, audit B3).
    expect(h.openMediaFile).toHaveBeenCalledWith(expect.anything(), "/api/jellyfin/stream/next/stream.mkv?static=true#etag-1");
    // Sans prendre au film en cours la place unique du relais.
    expect(h.close).toHaveBeenCalledWith(false);
  });

  it("garde son ouverture sur l'appareil — 16 Mio, pendant le film, rien de plus", async () => {
    // 28/09/2026 : l'épisode démarre depuis le disque même si le réseau tombe au générique.
    await warmNextEpisode("ep-5");
    expect(h.recordTitle).toHaveBeenCalledWith("louis", { itemId: "ep-5", startSeconds: 0, started: false }, 16, expect.anything(), true);
    // Et la source de préparation ne lit rien en avance : six mégaoctets pour rien, avant.
    const source = await h.open.mock.results[0].value;
    expect(source.withoutReadahead).toHaveBeenCalled();
  });

  it("garde d'abord, puis lit l'en-tête depuis l'appareil — jamais téléchargé deux fois", async () => {
    // Chasse aux défauts du 28/09 : l'en-tête et l'index partaient deux fois au réseau.
    const disk = { has: () => true };
    h.openDisk.mockResolvedValueOnce(disk);
    await warmNextEpisode("ep-7");
    expect(h.recordTitle.mock.invocationCallOrder[0]).toBeLessThan(h.open.mock.invocationCallOrder[0]);
    expect(h.openDisk).toHaveBeenCalledWith({ itemId: "ep-7", streamUrl: "/api/jellyfin/stream/next/stream.mkv?static=true", size: 1234, fileVersion: "etag-1" });
    expect(h.open).toHaveBeenCalledWith("/api/jellyfin/stream/next/stream.mkv?static=true", 1234, disk);
  });

  it("sans compte sur l'appareil, rien n'est gardé", async () => {
    h.account = null;
    await warmNextEpisode("ep-6");
    expect(h.recordTitle).not.toHaveBeenCalled();
  });

  it("n'essaie qu'une fois par épisode", async () => {
    await warmNextEpisode("ep-3");
    await warmNextEpisode("ep-3");
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it("ne dit rien d'un échec", async () => {
    h.open.mockRejectedValueOnce(new Error("réseau"));
    await expect(warmNextEpisode("ep-4")).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  close: vi.fn(),
  open: vi.fn(),
  openMediaFile: vi.fn(async () => ({ tracks: [] })),
  preload: vi.fn(async () => ({ streamUrl: "/api/jellyfin/stream/next/stream.mkv?static=true", sizeBytes: 1234 })),
  prefetchState: vi.fn(),
  recordTitle: vi.fn(async () => 18),
  account: "louis" as string | null,
}));
vi.mock("@/lib/webcodecs/byteSource", () => ({
  HttpByteSource: { open: (...a: unknown[]) => h.open(...a) },
}));
vi.mock("@/lib/webcodecs/mediaFile", () => ({ openMediaFile: (...a: unknown[]) => h.openMediaFile(...(a as [])) }));
vi.mock("@/lib/prefetch", () => ({ preloadQuietly: () => h.preload() }));
vi.mock("@/lib/playbackPrefetch", () => ({
  directInfoKey: (id: string) => `/api/jellyfin/direct/${id}`,
  prefetchPlaybackState: (id: string) => h.prefetchState(id),
}));

vi.mock("@/lib/resumeCache/recordTitle", () => ({ recordTitle: (...a: unknown[]) => h.recordTitle(...(a as [])) }));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => h.account }));

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
    expect(h.open).toHaveBeenCalledWith("/api/jellyfin/stream/next/stream.mkv?static=true", 1234);
    expect(h.openMediaFile).toHaveBeenCalledWith(expect.anything(), "/api/jellyfin/stream/next/stream.mkv?static=true");
    // Sans prendre au film en cours la place unique du relais.
    expect(h.close).toHaveBeenCalledWith(false);
  });

  it("garde son ouverture sur l'appareil — 16 Mio, pendant le film, rien de plus", async () => {
    // 28/09/2026 : l'épisode démarre depuis le disque même si le réseau tombe au générique.
    await warmNextEpisode("ep-5");
    expect(h.recordTitle).toHaveBeenCalledWith("louis", { itemId: "ep-5", startSeconds: 0, started: false, shareChunks: 0 }, 16, expect.anything(), true);
    // Et la source de préparation ne lit rien en avance : six mégaoctets pour rien, avant.
    const source = await h.open.mock.results[0].value;
    expect(source.withoutReadahead).toHaveBeenCalled();
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

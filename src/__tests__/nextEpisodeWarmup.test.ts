import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  close: vi.fn(),
  open: vi.fn(),
  openMediaFile: vi.fn(async () => ({ tracks: [] })),
  preload: vi.fn(async () => ({ streamUrl: "/api/jellyfin/stream/next/stream.mkv?static=true", sizeBytes: 1234 })),
  prefetchState: vi.fn(),
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

import { warmNextEpisode } from "@/lib/nextEpisodeWarmup";

beforeEach(() => {
  vi.clearAllMocks();
  h.open.mockImplementation(async () => ({ close: h.close }));
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

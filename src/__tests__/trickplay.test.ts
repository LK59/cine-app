import { describe, it, expect, vi, afterEach } from "vitest";
import { pickPreviewFrames, fetchTrickplayInfo } from "@/lib/trickplay";

describe("pickPreviewFrames", () => {
  it("returns no frames for an item with no thumbnails", () => {
    expect(pickPreviewFrames(0, 10_000)).toEqual([]);
  });

  it("returns a single frame for a one-thumbnail item", () => {
    expect(pickPreviewFrames(1, 10_000)).toEqual([0]);
  });

  it("spaces frames roughly every 10 minutes for a long file", () => {
    // 10s per thumbnail (Jellyfin's usual default) -> a 3h movie has 1080 thumbnails.
    // Target gap 10min / 10s-per-thumbnail = 60 thumbnails apart.
    const frames = pickPreviewFrames(1080, 10_000);
    expect(frames[0]).toBe(0);
    expect(frames[1]).toBe(60);
    expect(frames[2]).toBe(120);
    expect(frames.length).toBeGreaterThan(10); // plenty of frames across a 3h runtime
  });

  it("falls back to spreading a minimum of frames evenly for a short file", () => {
    // 5min file at 10s/thumbnail = 30 thumbnails total — the 10min target gap alone would
    // yield only 1 frame (index 0), so this must fall back to an even spread instead.
    const frames = pickPreviewFrames(30, 10_000);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames[0]).toBe(0);
    expect(Math.max(...frames)).toBeLessThan(30);
  });

  it("never returns duplicate or out-of-range indices", () => {
    const frames = pickPreviewFrames(217, 8_000);
    expect(new Set(frames).size).toBe(frames.length);
    for (const f of frames) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(217);
    }
  });
});

describe("fetchTrickplayInfo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null when the upstream request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const info = await fetchTrickplayInfo("abc123", "user-1", new AbortController().signal);
    expect(info).toBeNull();
  });

  it("returns null when the item has no Trickplay field for this id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const info = await fetchTrickplayInfo("abc123", "user-1", new AbortController().signal);
    expect(info).toBeNull();
  });

  it("picks the smallest available resolution and maps its fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          Trickplay: {
            abc123: {
              "320": { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: 500, Interval: 10000 },
              "480": { Width: 480, Height: 270, TileWidth: 10, TileHeight: 10, ThumbnailCount: 500, Interval: 10000 },
            },
          },
        }),
      })
    );
    const info = await fetchTrickplayInfo("abc123", "user-1", new AbortController().signal);
    expect(info).toEqual({
      width: 320,
      height: 180,
      tileWidth: 10,
      tileHeight: 10,
      thumbnailCount: 500,
      intervalMs: 10000,
    });
  });
});

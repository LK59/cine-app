import { config } from "@/lib/config";

export interface TrickplayInfo {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  thumbnailCount: number;
  intervalMs: number;
}

interface TrickplayResolution {
  Width: number;
  Height: number;
  TileWidth: number;
  TileHeight: number;
  ThumbnailCount: number;
  Interval: number;
}

// Jellyfin's trickplay grid: each fetched "tile" is itself a sprite sheet of TileWidth x
// TileHeight individual Width x Height thumbnails, taken every `Interval` ms through the file.
// The client locates a thumbnail for a given seek time by: thumbnailIndex = time_ms / Interval,
// tileIndex = thumbnailIndex / (TileWidth * TileHeight), and its row/col within that tile via
// the remainder — see PlayerControls' seek-preview code. Shared by trickplay/info/route.ts (the
// player's own scrub preview) and trickplay/preview/route.ts (the poster hover preview).
export async function fetchTrickplayInfo(
  itemId: string,
  userId: string,
  signal: AbortSignal
): Promise<TrickplayInfo | null> {
  // Verified live: Jellyfin's /Items/{id} returns a bare 400 ("Error processing request.", not
  // even JSON) when queried without a UserId — evidently required internally to resolve
  // user-relative fields even for Trickplay, which isn't itself user-specific data.
  const res = await fetch(`${config.jellyfin.url}/Items/${itemId}?Fields=Trickplay&UserId=${userId}`, {
    signal,
    headers: { "X-Emby-Token": config.jellyfin.apiKey },
  });
  if (!res.ok) return null;

  const item = (await res.json()) as { Trickplay?: Record<string, Record<string, TrickplayResolution>> };
  const resolutions = item.Trickplay?.[itemId];
  if (!resolutions) return null;

  // Smallest available width — plenty for a small preview, and keeps each tile image (already a
  // Width*TileWidth by Height*TileHeight sprite sheet) light to fetch.
  const [width, info] = Object.entries(resolutions).sort(([a], [b]) => Number(a) - Number(b))[0];

  return {
    width: Number(width),
    height: info.Height,
    tileWidth: info.TileWidth,
    tileHeight: info.TileHeight,
    thumbnailCount: info.ThumbnailCount,
    intervalMs: info.Interval,
  };
}

// Poster hover preview picks a handful of frames spread across the whole runtime rather than
// consecutive trickplay thumbnails (usually one every ~10s) — cycling those in sequence would
// play the first couple of minutes of the file in slow motion instead of giving a sense of the
// whole thing. MIN_PREVIEW_FRAMES keeps short files (where the ideal gap would otherwise leave
// only 1-2 frames) from looking static.
const TARGET_FRAME_GAP_MS = 10 * 60_000;
const MIN_PREVIEW_FRAMES = 4;

export function pickPreviewFrames(thumbnailCount: number, intervalMs: number): number[] {
  if (thumbnailCount <= 0 || intervalMs <= 0) return [];
  if (thumbnailCount === 1) return [0];

  const step = Math.max(1, Math.round(TARGET_FRAME_GAP_MS / intervalMs));
  const frames: number[] = [];
  for (let i = 0; i < thumbnailCount; i += step) frames.push(i);
  if (frames.length >= MIN_PREVIEW_FRAMES) return frames;

  // File too short for the target gap to yield enough frames — spread MIN_PREVIEW_FRAMES evenly
  // across it instead, rather than falling back toward near-continuous consecutive thumbnails.
  const altStep = Math.max(1, Math.floor(thumbnailCount / MIN_PREVIEW_FRAMES));
  const alt: number[] = [];
  for (let i = 0; i < thumbnailCount; i += altStep) alt.push(i);
  return alt;
}

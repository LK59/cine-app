"use client";

import { useEffect, useRef, useState } from "react";

interface PreviewData {
  itemId: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  frames: number[];
}

const HOVER_START_DELAY_MS = 700;
const FRAME_INTERVAL_MS = 500;

// Netflix-style hover preview built entirely from Jellyfin's trickplay sprite tiles (no video
// decode) — only ever mounted for items already in the library (see PosterCard), since a title
// not yet downloaded has no trickplay data to show. `hovering` is owned by the parent (its own
// hover-buttons overlay paints on top of this one with default pointer-events, which would
// otherwise swallow hit-testing for a hover listener placed on this component's own element —
// listening at the parent's outer container instead is immune to that, since mouseenter/
// mouseleave there fire off the container's whole bounding box regardless of which child is
// topmost inside it). Frames are spread across the whole runtime rather than consecutive
// trickplay thumbnails (usually one every ~10s) — see pickPreviewFrames in @/lib/trickplay.
export function PosterHoverPreview({
  tmdbId,
  mediaType,
  hovering,
}: {
  tmdbId: number;
  mediaType: "movie" | "series";
  hovering: boolean;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const dataRef = useRef<PreviewData | null>(null);
  // Sticky "confirmed nothing to preview here" (never in library / no trickplay yet) — skips
  // refetching on every subsequent re-hover of the same card.
  const noPreviewRef = useRef(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Fetch once per mount, on the first hover past the start delay — deliberately NOT
  // re-triggered by `data` changing (see dataRef), otherwise setting data mid-timeout would
  // re-run this effect and impose a second, redundant HOVER_START_DELAY_MS before cycling
  // could actually start.
  useEffect(() => {
    if (!hovering) return;
    if (typeof window === "undefined" || !window.matchMedia("(hover: hover)").matches) return;
    if (noPreviewRef.current || dataRef.current) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/jellyfin/trickplay/preview?tmdbId=${tmdbId}&mediaType=${mediaType}`);
        if (cancelled) return;
        if (!res.ok) { noPreviewRef.current = true; return; }
        setData((await res.json()) as PreviewData);
      } catch {
        if (!cancelled) noPreviewRef.current = true;
      }
    }, HOVER_START_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hovering, tmdbId, mediaType]);

  // Restarts from frame 0 on every fresh hover — applied during render (not in an effect), per
  // React's guidance for adjusting state from a prop change, same pattern PlayerControls uses
  // for its own per-item/per-session resets.
  const [resetForHovering, setResetForHovering] = useState(hovering);
  if (hovering !== resetForHovering) {
    setResetForHovering(hovering);
    if (hovering) setFrameIdx(0);
  }

  // Cycles independently of the fetch above — starts the instant data + hovering are both true,
  // with no extra delay on top of the fetch's own.
  useEffect(() => {
    if (!hovering || !data) return;
    const id = setInterval(() => setFrameIdx((i) => i + 1), FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hovering, data]);

  if (!hovering || !data || data.frames.length === 0) return null;

  const frame = data.frames[frameIdx % data.frames.length];
  const perTile = data.tileWidth * data.tileHeight;
  const tileIndex = Math.floor(frame / perTile);
  const posInTile = frame % perTile;
  const row = Math.floor(posInTile / data.tileWidth);
  const col = posInTile % data.tileWidth;
  const tileUrl = `/api/jellyfin/trickplay/tile?itemId=${data.itemId}&width=${data.width}&index=${tileIndex}`;

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden bg-black">
      {/* Sized to the native 16:9-ish trickplay aspect ratio and centered — deliberately
          letterboxed rather than cropped to fill the poster's 2:3 box, so the preview doesn't
          discard most of the frame just to match the poster's shape. Percentage-based
          background-size/-position is the standard CSS sprite-sheet technique: at this box's own
          size (one tile), the full sheet is exactly tileWidth/tileHeight times larger, so
          `{tileWidth*100}%` sizes it correctly at ANY rendered width with no JS measurement. */}
      <div
        className="w-full"
        style={{
          aspectRatio: `${data.width} / ${data.height}`,
          backgroundImage: `url(${tileUrl})`,
          backgroundSize: `${data.tileWidth * 100}% ${data.tileHeight * 100}%`,
          backgroundPosition: `${data.tileWidth > 1 ? (col / (data.tileWidth - 1)) * 100 : 0}% ${
            data.tileHeight > 1 ? (row / (data.tileHeight - 1)) * 100 : 0
          }%`,
        }}
      />
    </div>
  );
}

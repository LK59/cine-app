"use client";

import { useCallback, useRef, useState } from "react";
import { Play, Pause, X } from "lucide-react";

const MARGIN = 16;
// Below this width the mini player uses a slightly smaller box — same 16:9-ish
// proportions, just scaled down so it doesn't dominate a phone screen.
const MOBILE_BREAKPOINT = 640;
// MobileNav (the bottom tab bar) is hidden at md (768px)+ — clear it plus some
// breathing room for the home-indicator area below that width.
const NAV_BREAKPOINT = 768;
const TAP_THRESHOLD = 6; // px of movement below which a pointerdown→up counts as a tap, not a drag

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

function getMiniSize(): Size {
  const mobile = typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;
  return mobile ? { width: 152, height: 85 } : { width: 180, height: 101 };
}

function getBottomClearance(): number {
  return typeof window !== "undefined" && window.innerWidth < NAV_BREAKPOINT ? 88 : MARGIN;
}

function defaultPosition(size: Size): Point {
  if (typeof window === "undefined") return { x: 0, y: 0 };
  return {
    x: window.innerWidth - size.width - MARGIN,
    y: window.innerHeight - size.height - getBottomClearance(),
  };
}

function clampPosition(pos: Point, size: Size): Point {
  if (typeof window === "undefined") return pos;
  const maxX = Math.max(MARGIN, window.innerWidth - size.width - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - size.height - getBottomClearance());
  return {
    x: Math.min(Math.max(MARGIN, pos.x), maxX),
    y: Math.min(Math.max(MARGIN, pos.y), maxY),
  };
}

export interface MiniPlayerDrag {
  pos: Point;
  size: Size;
  isDragging: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
  };
}

// Free-form dragging for the mini player, positioned via `pos`/`size` (the caller applies
// them to its own container's style so the video element it wraps never remounts — see
// PlayerHost). Same Pointer Events pattern as ActionSheet's swipe-to-close: unifies
// mouse + touch, no extra dependency. Resets to the bottom-right corner every time the mini
// player (re)activates; otherwise free — no snap-to-corner.
export function useMiniPlayerDrag(active: boolean, onTap: () => void): MiniPlayerDrag {
  const [size] = useState(getMiniSize);
  const [pos, setPos] = useState<Point>(() => defaultPosition(size));
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);
  const start = useRef<Point>({ x: 0, y: 0 });
  const origin = useRef<Point>({ x: 0, y: 0 });
  const moved = useRef(0);

  // Re-centers on the default corner each time the mini player switches on — applied during
  // render (not in an effect) per React's guidance for adjusting state from a prop change.
  const [resetForActive, setResetForActive] = useState(active);
  if (active !== resetForActive) {
    setResetForActive(active);
    if (active) setPos(defaultPosition(size));
  }

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging.current = true;
    moved.current = 0;
    start.current = { x: e.clientX, y: e.clientY };
    origin.current = pos;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    moved.current = Math.max(moved.current, Math.hypot(dx, dy));
    setPos(clampPosition({ x: origin.current.x + dx, y: origin.current.y + dy }, size));
  }, [size]);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setIsDragging(false);
    if (moved.current < TAP_THRESHOLD) onTap();
  }, [onTap]);

  return { pos, size, isDragging, handlers: { onPointerDown, onPointerMove, onPointerUp } };
}

interface MiniPlayerChromeProps {
  title: string;
  playing: boolean;
  onTogglePlay: () => void;
  onClose: () => void;
}

// Purely presentational overlay for the mini player — the video element itself lives in
// PlayerHost (as a sibling, not a child, of this component) so it never remounts when
// switching between full and mini. Buttons stop pointerdown propagation so tapping them
// doesn't also register as the "tap anywhere else to expand" gesture handled by the drag
// hook above on the shared container.
export function MiniPlayerChrome({ title, playing, onTogglePlay, onClose }: MiniPlayerChromeProps) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/80 via-transparent to-black/40">
      <div className="pointer-events-auto flex justify-end p-1">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="rounded-full bg-black/50 p-1 text-white hover:bg-black/70"
        >
          <X size={12} />
        </button>
      </div>
      <div className="pointer-events-auto flex items-center gap-1.5 p-1.5">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePlay();
          }}
          className="shrink-0 rounded-full bg-white/15 p-1 text-white hover:bg-white/25"
        >
          {playing ? <Pause size={11} /> : <Play size={11} />}
        </button>
        <p className="truncate text-[10px] font-medium text-white/90">{title}</p>
      </div>
    </div>
  );
}

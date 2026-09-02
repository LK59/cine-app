"use client";

import { useCallback, useRef, useState } from "react";

// Drag-down-to-close for a full-screen sheet, driven from one grab handle (here: the banner
// artwork at the top of the mobile detail sheet, above its Lire button).
//
// Same Pointer Events approach as ActionSheet's own swipe-to-close and the mini player's drag —
// mouse, touch and pen through one code path, no dependency. What this adds over those is that
// the sheet tracks the finger 1:1 for the whole gesture and can be dragged back up again: the
// offset is state, applied as a transform with the transition switched off while the finger is
// down, so nothing is animating towards a target — the sheet simply is where the finger is.
//
// Release decides: past the distance threshold, or thrown downwards fast enough that the intent
// is obvious even from a short drag, it closes; otherwise it springs back.

// A shade under a quarter of the screen, capped so a tall phone doesn't ask for a longer drag
// than a small one.
const DISTANCE_RATIO = 0.22;
const MAX_DISTANCE = 160;
// px per millisecond — a flick, not a slow drag that happened to be brief.
const VELOCITY_THRESHOLD = 0.5;

export interface SwipeToDismiss {
  /** Current downward offset in px. 0 when idle. */
  offset: number;
  /** True while a finger is down — the caller kills its transition so the sheet tracks 1:1. */
  dragging: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

export function useSwipeToDismiss(onDismiss: () => void): SwipeToDismiss {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);
  const startY = useRef(0);
  const startedAt = useRef(0);
  const latest = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    active.current = true;
    startY.current = e.clientY;
    startedAt.current = performance.now();
    latest.current = 0;
    setDragging(true);
    // Capture: the finger drags the sheet down out from under itself, so it leaves the handle
    // almost immediately — without this the gesture would die on the first pixel.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!active.current) return;
    // Clamped at 0 rather than allowed to go negative: dragging back up returns the sheet
    // exactly to where it started and stops there, which is what "you can change your mind"
    // should feel like. Pulling it up beyond its own top edge would just tear it off the screen.
    const next = Math.max(0, e.clientY - startY.current);
    latest.current = next;
    setOffset(next);
  }, []);

  const finish = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    setDragging(false);

    const distance = latest.current;
    const elapsed = Math.max(performance.now() - startedAt.current, 1);
    const threshold = Math.min(MAX_DISTANCE, window.innerHeight * DISTANCE_RATIO);

    if (distance > threshold || distance / elapsed > VELOCITY_THRESHOLD) {
      // Carries on off the bottom instead of snapping back first — the close animation is the
      // continuation of the gesture, not a separate thing that happens after it.
      setOffset(window.innerHeight);
      onDismiss();
    } else {
      setOffset(0);
    }
  }, [onDismiss]);

  return {
    offset,
    dragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish },
  };
}

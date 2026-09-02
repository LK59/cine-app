"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Wraps a close callback so an overlay can play a CSS exit animation before it actually
 * unmounts, instead of vanishing the instant close is requested — React removes a conditionally
 * rendered `{open && <X/>}` from the DOM the very same render `open` goes false, with zero room
 * for a transition to play. This is self-contained on purpose (no change needed on the parent's
 * side, no lifted "is this closing" state): the component keeps calling the SAME `onClose` prop
 * it already had, just via `requestClose()` instead of directly — that's what buys the delay.
 *
 * Usage: replace every place a component used to call its `onClose` prop directly (Escape, a
 * back button, a "play started" auto-close effect) with `requestClose()`, and drive the exit
 * animation class off `closing` (e.g. `closing ? "animate-fade-out" : "animate-fade-in"`). The
 * real `onClose` only fires after `exitMs`, once the animation has had time to actually play.
 */
export function useDelayedClose(onClose: () => void, exitMs: number): { closing: boolean; requestClose: () => void } {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref, not a plain closure over the onClose param — requestClose is called from event handlers
  // that captured whichever onClose was current at THEIR render, but the timeout should still
  // fire the LATEST one if the prop identity ever changes mid-animation. Synced via its own
  // effect (not written during render) per this project's react-hooks/refs rule.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // useCallback so it has a stable identity across renders — callers put it in effect
  // dependency arrays (the auto-close-on-play effect, the Escape/Backspace keydown listener),
  // and a fresh function reference every render would otherwise re-subscribe those on every
  // unrelated re-render (harmless since both are idempotent, but wasteful).
  const requestClose = useCallback(() => {
    if (timerRef.current) return; // already closing — a repeat Escape/click mid-fade is a no-op
    setClosing(true);
    timerRef.current = setTimeout(() => onCloseRef.current(), exitMs);
  }, [exitMs]);

  return { closing, requestClose };
}

"use client";

import { useEffect, useState } from "react";

// Auto-advancing index for a hero carousel — the same 8-second cadence DashboardHero uses on the
// main screen, so both parts of the app rotate at the same rhythm.
//
// The timer is re-armed on every index change, whether it came from the timer itself or from a
// manual jump, so tapping a dot always gets a full interval rather than inheriting whatever was
// left of the previous one.
export const ROTATE_MS = 8000;

export function useRotatingIndex(length: number, paused = false): [number, (next: number) => void] {
  const [index, setIndex] = useState(0);

  // A shorter list (a tab switch, a payload that lost items) can leave the index past the end.
  // Adjusted during render rather than in an effect, per React's guidance for deriving state
  // from props — and this project's set-state-in-effect rule.
  if (length > 0 && index >= length) setIndex(0);

  useEffect(() => {
    if (paused || length <= 1) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % length), ROTATE_MS);
    return () => clearTimeout(id);
  }, [length, index, paused]);

  return [length > 0 ? index % length : 0, setIndex];
}

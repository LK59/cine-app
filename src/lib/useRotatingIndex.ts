"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/reducedMotion";

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

  // Pas de rotation automatique pour qui a demandé moins de mouvement : un contenu qui change seul
  // est exactement ce que ce réglage refuse. Les gestes et les barres, eux, restent.
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (paused || reducedMotion || length <= 1) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % length), ROTATE_MS);
    return () => clearTimeout(id);
  }, [length, index, paused, reducedMotion]);

  return [length > 0 ? index % length : 0, setIndex];
}

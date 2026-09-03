"use client";

import { useCallback, useEffect, useState } from "react";

/** How long the word stays up. Long enough to read, short enough not to become furniture. */
export const NEGOTIATING_MS = 4000;

export interface StableFallback {
  /** Items the experimental player has given up on, for this session only. */
  handedOver: string[];
  /** Whether to show the viewer that something is being arranged on their behalf. */
  negotiating: boolean;
  /** Why it happened, kept for the technical panel of the player that took over. */
  reason: string | null;
  /** Called by the experimental player when it cannot go on. Idempotent per item. */
  stepAside: (itemId: string, reason: string) => void;
}

/**
 * The handover from the experimental player to the stable one.
 *
 * Deliberately not persisted: it applies to the session in front of the viewer, so the setting
 * stays the source of truth and the next playback tries the good path again. That is what makes
 * a step down a measurement rather than a verdict — a file that fails once because a decoder was
 * busy is not a file that cannot be played.
 *
 * Recorded per item rather than globally, for the same reason: one file the experimental player
 * cannot carry says nothing about the next.
 */
export function useStableFallback(): StableFallback {
  const [handedOver, setHandedOver] = useState<string[]>([]);
  const [negotiating, setNegotiating] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  const stepAside = useCallback((itemId: string, why: string) => {
    setHandedOver((ids) => {
      // Already given up on: the word has been said and saying it twice would only interrupt
      // a player that is by now busy playing.
      if (ids.includes(itemId)) return ids;
      setReason(why);
      setNegotiating(true);
      return [...ids, itemId];
    });
  }, []);

  useEffect(() => {
    if (!negotiating) return;
    const id = setTimeout(() => setNegotiating(false), NEGOTIATING_MS);
    return () => clearTimeout(id);
  }, [negotiating]);

  return { handedOver, negotiating, reason, stepAside };
}

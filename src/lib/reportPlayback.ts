"use client";

import type { PlayerEventKind } from "@/lib/playerLog";

/**
 * Tells the server what the player did, so a silent step down stops being an invisible one.
 *
 * Fire and forget, and deliberately unable to fail loudly: a diary entry that could interrupt a
 * film would be worse than no diary at all. `keepalive` so an event sent as the page goes away —
 * which is when the interesting ones happen — survives the teardown.
 */
export function reportPlayback(kind: PlayerEventKind, fields: Record<string, unknown>): void {
  try {
    void fetch("/api/player/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, fields }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Nothing here is worth a broken player.
  }
}

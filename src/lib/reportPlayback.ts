"use client";

import type { PlayerEventKind } from "@/lib/playerLog";
import { APP_BUILD } from "@/lib/appBuild";

/**
 * Tells the server what the player did, so a silent step down stops being an invisible one.
 *
 * Fire and forget, and deliberately unable to fail loudly: a diary entry that could interrupt a
 * film would be worse than no diary at all. `keepalive` so an event sent as the page goes away —
 * which is when the interesting ones happen — survives the teardown.
 */
export function reportPlayback(kind: PlayerEventKind, fields: Record<string, unknown>): void {
  try {
    // Le code qui a écrit la ligne, et non celui que le serveur sert : un onglet ouvert depuis le
    // matin écrivait au journal avec le code du matin, et ses blocages passaient pour ceux de la
    // version du soir (25/09/2026). Un bilan renvoyé après coup porte déjà le sien (`unsentStop`).
    const body = JSON.stringify({ kind, fields: { build: APP_BUILD, ...fields } });
    /**
     * L'arrêt part par `sendBeacon` quand le navigateur le propose.
     *
     * C'est la ligne qui part le plus souvent pendant que la page s'en va — la croix, puis
     * `pagehide` —, et c'est précisément le moment où WebKit abandonne le plus volontiers un
     * `fetch`, `keepalive` ou non. Une balise est faite pour ça : le navigateur la garde en file
     * après la page. Refusée (charge trop grosse, file pleine), elle retombe sur `fetch`.
     */
    if (kind === "stop" && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon("/api/player/log", new Blob([body], { type: "application/json" }))) return;
    }
    void fetch("/api/player/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Nothing here is worth a broken player.
  }
}

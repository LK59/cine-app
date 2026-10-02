"use client";

import type { PlayerEventKind } from "@/lib/playerLog";
import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";
import { isIPadPosingAsMac } from "@/lib/deviceLabel";
import { flushUnsentLines, keepUnsentLine, newLineId, shouldKeep } from "@/lib/unsentLines";

/**
 * Tells the server what the player did, so a silent step down stops being an invisible one.
 *
 * Fire and forget, and deliberately unable to fail loudly: a diary entry that could interrupt a
 * film would be worse than no diary at all. `keepalive` so an event sent as the page goes away —
 * which is when the interesting ones happen — survives the teardown.
 *
 * Une ligne qui n'a pas pu partir n'est plus perdue : elle attend sur l'appareil et repart après le
 * prochain envoi réussi (`unsentLines.ts`, 01/10/2026).
 */
export function reportPlayback(kind: PlayerEventKind, fields: Record<string, unknown>): void {
  try {
    // Le code qui a écrit la ligne, et non celui que le serveur sert : un onglet ouvert depuis le
    // matin écrivait au journal avec le code du matin, et ses blocages passaient pour ceux de la
    // version du soir (25/09/2026). Un bilan renvoyé après coup porte déjà le sien (`unsentStop`).
    // La version à côté : le build dit quel commit, elle dit quelle livraison.
    // `touch` à côté de la signature : sans lui, l'activité nomme un iPad « Mac » (`deviceLabel`).
    // Ici et non dans chaque lecteur : les deux écrivent `agent`, et passent tous deux par ici.
    const touch = typeof fields.agent === "string" && isIPadPosingAsMac() ? { touch: true } : {};
    const sent = { build: APP_BUILD, version: APP_VERSION, ...fields, ...touch };
    // L'identifiant qui permet à la route de reconnaître un renvoi déjà reçu (`unsentLines.ts`).
    const lineId = newLineId();
    const body = JSON.stringify({ kind, fields: { ...sent, lineId } });
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
    }).then(
      (res) => {
        // Le serveur est de retour : ce qui attendait part derrière.
        if (res.ok) void flushUnsentLines();
        else if (shouldKeep(res.status)) keepUnsentLine(lineId, kind, sent);
      },
      // Pas de réponse : le serveur redémarre, ou le réseau du spectateur est tombé. Gardée pour
      // plus tard (01/10/2026 — un point de réserve perdu pendant un redémarrage du conteneur).
      () => keepUnsentLine(lineId, kind, sent)
    );
  } catch {
    // Nothing here is worth a broken player.
  }
}

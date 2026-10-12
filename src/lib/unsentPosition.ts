"use client";

import { persistedCacheAccount } from "@/lib/persistentCache";

/**
 * La position d'un titre que Jellyfin n'a pas reçue, gardée sur l'appareil jusqu'à ce qu'elle passe
 * (DECISIONS.md §78).
 *
 * Les battements (toutes les 10 s) et l'arrêt d'une lecture partent vers Jellyfin et, s'ils
 * échouaient, se perdaient (`usePlaybackSession` avalait l'erreur). Une coupure en plein film, puis
 * la croix pendant qu'elle dure : l'arrêt ne partait pas, et la reprise suivante repartait du
 * dernier battement passé — ou de la position d'ouverture. Le bilan gardé pour une page tuée
 * (`unsentStop`) ne couvrait que la page tuée ; la croix l'effaçait.
 *
 * Ici : tout rapport qui échoue (pas de réponse, ou un 5xx) écrit la position de son titre ; tout
 * rapport accepté pour ce titre l'efface — il porte une position plus récente. Ce qui reste part dès
 * qu'un rapport repasse (le réseau est revenu) et au lancement suivant, puis chaque minute
 * (`PlaybackProvider`), par la route d'arrêt marquée `late` : le serveur ne fait qu'*avancer* une
 * position, jamais la reculer, et seulement si rien n'a été lu depuis (`recoverLostPosition`, la
 * règle des bilans perdus).
 *
 * Une clé par titre et par compte ; le stockage peut manquer — rien ici ne gêne un film.
 */

const PREFIX = "cine:unsent-position:";
/** Au-delà d'une semaine, la position ne veut plus rien dire. */
const KEEP_MS = 7 * 24 * 3600_000;

interface Saved {
  itemId: string;
  seconds: number;
  savedAt: number;
  account: string | null;
}

export function saveUnsentPosition(itemId: string, seconds: number, now = Date.now()): void {
  try {
    if (!itemId || !(seconds > 0) || !Number.isFinite(seconds)) return;
    const saved: Saved = { itemId, seconds, savedAt: now, account: persistedCacheAccount() };
    localStorage.setItem(PREFIX + itemId, JSON.stringify(saved));
  } catch {
    /* pas de stockage : pas de filet */
  }
}

/** Un rapport pour ce titre vient d'être accepté : il portait une position plus récente. */
export function clearUnsentPosition(itemId: string): void {
  try {
    localStorage.removeItem(PREFIX + itemId);
  } catch {
    /* rien */
  }
}

export function findUnsentPositions(now = Date.now(), account: string | null = persistedCacheAccount()): Saved[] {
  if (!account) return [];
  const found: Saved[] = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      let saved: Saved | null = null;
      try {
        saved = JSON.parse(localStorage.getItem(key) ?? "null") as Saved | null;
      } catch {
        saved = null;
      }
      if (!saved || typeof saved.itemId !== "string" || typeof saved.seconds !== "number" || typeof saved.savedAt !== "number") {
        localStorage.removeItem(key);
        continue;
      }
      if (now - saved.savedAt > KEEP_MS) {
        localStorage.removeItem(key);
        continue;
      }
      // Celle d'un autre compte attend le retour de ce compte.
      if (saved.account && saved.account !== account) continue;
      found.push(saved);
    }
  } catch {
    /* stockage indisponible */
  }
  return found;
}

let flushing = false;

/**
 * Envoie les positions restées sur l'appareil. `except` : le titre dont un rapport vient de passer
 * (sa position gardée vient d'être effacée, ou le sera par le suivant).
 */
export async function flushUnsentPositions(now = Date.now(), except?: string): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (const saved of findUnsentPositions(now)) {
      if (saved.itemId === except) continue;
      try {
        const res = await fetch("/api/jellyfin/playback/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: saved.itemId,
            positionTicks: Math.floor(saved.seconds * 10_000_000),
            late: true,
            lateByMs: now - saved.savedAt,
          }),
        });
        // Accepté, ou refusé pour de bon (400) : effacé. Sinon (5xx, session absente) : plus tard.
        if (res.ok || res.status === 400) localStorage.removeItem(PREFIX + saved.itemId);
        else return;
      } catch {
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

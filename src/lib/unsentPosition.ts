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
/**
 * Y a-t-il peut-être quelque chose en attente ? Faux tant que rien n'a été gardé dans cette page : un
 * rapport accepté sur un bon réseau ne touche alors pas au stockage. Le lancement (`flushUnsentPositions`)
 * le relit une fois.
 */
let maybePending = false;

/** Un rapport accepté a-t-il quelque chose à effacer ou à renvoyer derrière lui ? */
export function unsentPositionsPending(): boolean {
  return maybePending;
}
/** Au-delà d'une semaine, la position ne veut plus rien dire. */
const KEEP_MS = 7 * 24 * 3600_000;

interface Saved {
  itemId: string;
  seconds: number;
  savedAt: number;
  account: string | null;
}

/**
 * Une clé par compte *et* par titre (13/10/2026). Il n'y en avait qu'une par titre : sur un iPad
 * partagé, le même film regardé par un autre compte effaçait (un battement accepté) ou écrasait (un
 * battement en échec) la position que le premier n'avait pas encore pu rendre à Jellyfin. Les clés
 * d'avant (titre seul) se lisent toujours : chacune porte son compte.
 */
function keyFor(itemId: string, account: string | null): string {
  return PREFIX + (account ? `${account}:` : "") + itemId;
}

export function saveUnsentPosition(itemId: string, seconds: number, now = Date.now()): void {
  try {
    if (!itemId || !(seconds > 0) || !Number.isFinite(seconds)) return;
    const account = persistedCacheAccount();
    const saved: Saved = { itemId, seconds, savedAt: now, account };
    localStorage.setItem(keyFor(itemId, account), JSON.stringify(saved));
    maybePending = true;
  } catch {
    /* pas de stockage : pas de filet */
  }
}

/** Un rapport pour ce titre vient d'être accepté : il portait une position plus récente. */
export function clearUnsentPosition(itemId: string): void {
  try {
    const account = persistedCacheAccount();
    localStorage.removeItem(keyFor(itemId, account));
    // Une clé d'avant (titre seul) : effacée seulement si elle est à ce compte.
    const legacy = PREFIX + itemId;
    const saved = JSON.parse(localStorage.getItem(legacy) ?? "null") as Saved | null;
    if (saved && (!saved.account || saved.account === account)) localStorage.removeItem(legacy);
  } catch {
    /* rien */
  }
}

export function findUnsentPositions(now = Date.now(), account: string | null = persistedCacheAccount()): Saved[] {
  return findKept(now, account).map(({ saved }) => saved);
}

/** Les positions en attente pour ce compte, avec la clé sous laquelle chacune est gardée. */
function findKept(now: number, account: string | null): { key: string; saved: Saved }[] {
  if (!account) return [];
  const found: { key: string; saved: Saved }[] = [];
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
      found.push({ key, saved });
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
    const found = findKept(now, persistedCacheAccount());
    maybePending = found.length > 0;
    for (const { key, saved } of found) {
      if (saved.itemId === except) continue;
      try {
        const res = await fetch("/api/jellyfin/playback/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: saved.itemId,
            positionTicks: Math.floor(saved.seconds * 10_000_000),
            late: true,
            // Jamais négatif : une horloge reculée depuis l'écriture (réglage, synchronisation)
            // donnait un retard négatif, que la route refuse d'un 400 — lu plus bas comme « refusée
            // pour de bon », et la position gardée pendant la coupure était effacée (13/10/2026).
            // Même borne que les lignes renvoyées (`unsentLines`).
            lateByMs: Math.max(0, now - saved.savedAt),
          }),
        });
        // Accepté, ou refusé pour de bon (400) : effacé. Sinon (5xx, session absente) : plus tard.
        if (res.ok || res.status === 400) localStorage.removeItem(key);
        else return;
      } catch {
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

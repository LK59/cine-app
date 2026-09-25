"use client";

import { APP_BUILD } from "@/lib/appBuild";

/**
 * Le bilan d'une séance, gardé sur l'appareil tant qu'il n'est pas parti.
 *
 * Une page qu'iOS tue en arrière-plan ne reçoit ni `pagehide` ni rien d'autre : sa ligne `stop`
 * ne peut pas partir à ce moment-là. Sur les 163 séances du 21 au 23/09/2026, douze n'en avaient
 * pas — l'application quittée, tuée, relancée, et le même film rouvert à la position que Jellyfin
 * avait gardée. Le bilan est donc écrit ici au fil de la séance, effacé quand l'arrêt part, et
 * envoyé au lancement suivant s'il est resté là : en retard, marqué `why: "lost"`, mais avec ce
 * qui s'était passé.
 *
 * Une clé par séance, pour que deux onglets ne s'écrasent pas. Un bilan n'est déclaré perdu
 * qu'après `ORPHAN_AFTER_MS` sans mise à jour : la séance vivante le réécrit bien plus souvent.
 * Si un onglet endormi se réveille après avoir été déclaré perdu, sa vraie ligne `stop` part
 * quand même — le bilan hebdomadaire garde la dernière ligne d'une même séance (`session`).
 *
 * Le stockage du navigateur peut manquer ou refuser (navigation privée, stockage plein) : rien
 * ici ne doit jamais gêner un film, tout est donc dans un `try`.
 */

const PREFIX = "cine:unsent-stop:";
/** Deux minutes sans mise à jour : la séance vivante réécrit toutes les 30 s au plus. */
export const ORPHAN_AFTER_MS = 2 * 60_000;

interface Saved {
  savedAt: number;
  fields: Record<string, unknown>;
}

export function saveUnsentStop(session: string, fields: Record<string, unknown>, now = Date.now()): void {
  try {
    // Le build de la séance, gardé avec elle : le bilan part au lancement suivant, qui peut tourner
    // sur un autre code.
    localStorage.setItem(PREFIX + session, JSON.stringify({ savedAt: now, fields: { build: APP_BUILD, ...fields } } satisfies Saved));
  } catch {
    // Pas de stockage : la séance se passera de filet.
  }
}

export function clearUnsentStop(session: string): void {
  try {
    localStorage.removeItem(PREFIX + session);
  } catch {
    // Rien à faire.
  }
}

/**
 * Les bilans restés en plan, prêts à envoyer — sans les retirer : ils ne partent du stockage
 * qu'une fois acceptés (voir `flushOrphanStops`).
 */
export function findOrphanStops(now = Date.now()): { key: string; fields: Record<string, unknown> }[] {
  const found: { key: string; fields: Record<string, unknown> }[] = [];
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
      // Illisible : on ne le gardera pas indéfiniment.
      if (!saved || typeof saved.savedAt !== "number" || !saved.fields) {
        localStorage.removeItem(key);
        continue;
      }
      if (now - saved.savedAt < ORPHAN_AFTER_MS) continue;
      found.push({ key, fields: { ...saved.fields, why: "lost", lateByMs: now - saved.savedAt } });
    }
  } catch {
    // Stockage indisponible.
  }
  return found;
}

/**
 * Envoie ce qui est resté en plan. Appelé au lancement, puis chaque minute.
 *
 * Par `fetch` et non par balise, et retiré seulement sur une réponse acceptée : l'application
 * s'ouvre aussi sur l'écran de connexion, où la route refuse faute de session — un bilan envoyé
 * là et effacé aussitôt aurait été perdu une seconde fois.
 */
let flushing = false;

export async function flushOrphanStops(now = Date.now()): Promise<void> {
  // Un envoi lent ne doit pas croiser le suivant : la même ligne partirait deux fois.
  if (flushing) return;
  flushing = true;
  try {
    await sendOrphans(now);
  } finally {
    flushing = false;
  }
}

async function sendOrphans(now: number): Promise<void> {
  for (const { key, fields } of findOrphanStops(now)) {
    try {
      const res = await fetch("/api/player/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "stop", fields }),
      });
      if (res.ok) localStorage.removeItem(key);
      // 400 : le serveur ne veut pas de cette ligne, et ne la voudra jamais.
      else if (res.status === 400) localStorage.removeItem(key);
    } catch {
      // Hors ligne : ce sera pour la prochaine fois.
    }
  }
}

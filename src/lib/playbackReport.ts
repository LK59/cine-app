// Un rapport de lecture à Jellyfin, et ce qu'on fait quand Jellyfin refuse le jeton qui le porte.
//
// Les trois routes (`playing`, `progress`, `stop`) répondaient 502 à un refus, sans rien écrire
// nulle part : le lecteur continuait, Jellyfin ne recevait rien, et personne ne le voyait. Le
// 24/09/2026, un compte a ainsi regardé deux films en entier sans qu'une seconde en soit gardée —
// son jeton avait été révoqué par une réinitialisation de mot de passe (voir `jellyfinToken.ts`).
//
// Désormais un refus (401) n'interrompt pas le film : la position est écrite avec la clé
// d'administration, avec les mêmes règles que Jellyfin applique à un arrêt, la session est marquée
// pour que le prochain chargement de page redemande la connexion, et le refus est journalisé une
// fois. Toute autre erreur reste un 502, comme avant.

import { NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { withCache } from "@/lib/server-cache";
import { HttpError } from "@/lib/http";
import { logError } from "@/lib/logger";
import { markJellyfinTokenDead } from "@/lib/jellyfinToken";
import type { SessionPayload } from "@/lib/auth";

/**
 * Les seuils de reprise de Jellyfin (Tableau de bord → Lecture → Reprise) : sous le minimum, un
 * arrêt ne garde pas de position ; au-delà du maximum, le titre est vu et la position repart à zéro.
 *
 * Lus chez Jellyfin, et non écrits ici (09/10/2026) : ils étaient recopiés à leurs valeurs par défaut
 * (5 % et 90 %), et le serveur est passé à 2 % et 95 % — ce filet aurait appliqué une autre règle que
 * Jellyfin, la seule qui compte. Les valeurs par défaut ne servent que si Jellyfin ne répond pas.
 */
const DEFAULT_THRESHOLDS = { min: 5, max: 90 };
const THRESHOLDS_TTL_MS = 10 * 60_000;

async function resumeThresholds(): Promise<{ min: number; max: number }> {
  try {
    return await withCache("jf:resume-thresholds", THRESHOLDS_TTL_MS, async () => {
      const c = await jellyfin.getServerConfiguration();
      const min = typeof c.MinResumePct === "number" ? c.MinResumePct : DEFAULT_THRESHOLDS.min;
      const max = typeof c.MaxResumePct === "number" ? c.MaxResumePct : DEFAULT_THRESHOLDS.max;
      return { min, max };
    });
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

type Kind = "playing" | "progress" | "stop";

/** Ce que Jellyfin aurait retenu de ce rapport, écrit avec la clé d'administration. */
async function saveAsAdmin(userId: string, itemId: string, kind: Kind, positionTicks: number): Promise<string> {
  // Un démarrage ne porte rien à garder : la position suivra avec le premier rapport de progression.
  if (kind === "playing") return "rien à garder";
  if (kind === "progress") {
    await jellyfin.savePositionAsAdmin(userId, itemId, positionTicks);
    return "position";
  }
  const [runtime, thresholds] = await Promise.all([jellyfin.getRunTimeTicks(userId, itemId), resumeThresholds()]);
  const pct = runtime ? (positionTicks / runtime) * 100 : null;
  if (pct !== null && pct >= thresholds.max) {
    await jellyfin.markPlayed(userId, itemId);
    return "vu";
  }
  if (pct !== null && pct < thresholds.min) {
    await jellyfin.savePositionAsAdmin(userId, itemId, 0);
    return "position effacée";
  }
  await jellyfin.savePositionAsAdmin(userId, itemId, positionTicks);
  return "position";
}

/**
 * Envoie le rapport ; sur un refus du jeton, garde la position par la clé d'administration.
 * `session` doit porter `jfId` et `jfToken` — les routes l'ont déjà vérifié.
 */
export async function reportPlayback(
  session: SessionPayload & { jfId: string },
  kind: Kind,
  itemId: string,
  positionTicks: number,
  send: () => Promise<unknown>
): Promise<NextResponse> {
  try {
    await send();
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 401)) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur Jellyfin" }, { status: 502 });
    }
    markJellyfinTokenDead(session, `rapport de lecture (${kind})`);
    try {
      const saved = await saveAsAdmin(session.jfId, itemId, kind, positionTicks);
      return NextResponse.json({ ok: true, savedBy: "admin", saved });
    } catch (saveErr) {
      // Le filet lui-même a échoué : cette fois, rien n'est gardé, et il faut que ça se lise.
      logError("jellyfin-token", saveErr, { user: session.jfUser ?? session.u, where: `sauvegarde de secours (${kind})`, itemId });
      return NextResponse.json({ error: "Position non enregistrée" }, { status: 502 });
    }
  }
}

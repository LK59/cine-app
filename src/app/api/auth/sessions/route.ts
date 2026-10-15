import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { sessionDb } from "@/lib/db";
import { logAuthEvent } from "@/lib/eventLogs";

async function getSession(req: NextRequest) {
  return verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
}

function userId(session: { jfId?: string; u: string }) {
  return session.jfId ?? session.u;
}

/** La ligne de l'appelant ; gardée — « Cet appareil » ne doit jamais faire échouer la liste. */
function lookupOwn(jti: string) {
  try {
    return sessionDb.find(jti);
  } catch {
    return null;
  }
}

export interface OtherSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  device: string | null;
}

/**
 * Les autres connexions ouvertes sur ce compte.
 *
 * Un simple compte ne dit rien : « 3 » ne permet ni de reconnaître une session oubliée sur un
 * ordinateur prêté, ni de constater qu'il n'y a rien d'anormal. Les dates, elles, le permettent —
 * et elles étaient déjà en base.
 */
export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const others = sessionDb.listOthers(userId(session), session.jti);
  /**
   * La session de l'appelant, à part (DECISIONS.md §99) : « Cet appareil » en tête de la liste.
   *
   * Treize lignes « Ouverte le 14 oct. · Vue le 14 oct. » ne disaient pas laquelle on tenait en main
   * (passe de nuit du 15/10/2026, BUREAU-27). Un champ à part et non un drapeau dans `sessions` : la
   * liste reste « les autres », celles que le bouton ferme, et un onglet resté sur la version d'avant
   * lit toujours le bon nombre. Jamais de `jti` ici non plus. Lue en base pour ses dates ; une
   * session absente de la table (la connexion locale de secours n'y est pas toujours) n'en a pas.
   */
  const own = lookupOwn(session.jti);
  return NextResponse.json({
    count: others.length,
    // Jamais le `jti` : c'est lui qui identifie une session, et une page n'a besoin que de la
    // reconnaître, pas de la nommer.
    sessions: others.map((s, i): OtherSession => ({ id: String(i), createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, device: s.device })),
    current: own ? ({ id: "current", createdAt: own.createdAt, lastSeenAt: own.lastSeenAt, device: own.device } satisfies OtherSession) : null,
  });
}

/**
 * Fermer toutes les autres.
 *
 * Toutes les autres *sessions Cine App*, et rien de plus : les sessions Jellyfin ouvertes pour
 * elles ne sont pas fermées. C'est délibéré, et redit le 24/09/2026 quand « Se déconnecter » s'est
 * mis à révoquer le jeton de sa propre connexion (voir `/api/auth/logout`). Le bouton doit vouloir dire « qu'on me déconnecte
 * d'ici », jamais « qu'on me coupe Jellyfin » — et pour qui lit l'étiquette, la nuance
 * n'existerait pas.
 *
 * Ce que ça laissait ouvert — un cookie volé emportant un jeton Jellyfin utilisable — est traité
 * autrement, et mieux : ce jeton est chiffré dans le cookie. Le lire demande la clé du serveur,
 * et qui l'a n'a plus besoin d'un cookie.
 */
export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const revoked = sessionDb.deleteOthers(userId(session), session.jti);
  logAuthEvent("others-closed", { user: session.jfUser ?? session.u, count: revoked });
  return NextResponse.json({ ok: true, revoked });
}

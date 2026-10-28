import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, type SessionPayload } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { isJellyfinId } from "@/lib/jellyfinPath";

/**
 * La porte de chaque route des livres (DECISIONS.md §127), avant toute lecture du corps et tout appel
 * à Jellyfin :
 *
 * - option coupée : 404, sans corps — la route n'existe pas, et rien ne dit qu'elle pourrait exister ;
 * - pas de session : 401 (le proxy l'a déjà dit, avec `x-session-expired`) ;
 * - un lien de partage : 404. `shareGate` ne laisse de toute façon passer aucune de ces adresses
 *   (liste fermée, §112) ; ceci est la même règle dite une seconde fois, au cas où.
 *
 * Un compte du foyer, `user` ou `admin`, lit les livres que Jellyfin lui laisse voir.
 */
export async function booksCaller(req: NextRequest): Promise<SessionPayload | NextResponse> {
  if (config.books?.enabled !== true) return new NextResponse(null, { status: 404 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new NextResponse(null, { status: 401 });
  if (session.role === "share") return new NextResponse(null, { status: 404 });
  return session;
}

/** L'identifiant d'un livre dans l'adresse, en minuscules, ou `null` s'il n'en a pas la forme. */
export function bookIdOf(raw: string | undefined): string | null {
  return isJellyfinId(raw) ? raw.toLowerCase() : null;
}

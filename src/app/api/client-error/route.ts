import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { logClientError } from "@/lib/logger";

/**
 * Le navigateur signalant une erreur qu'il a rencontrée — voir `reportClientError`.
 *
 * Ouvert à tous les comptes connectés, comme le journal du lecteur : ce sont les dix-sept qui
 * n'ouvriront jamais de console qu'on veut entendre. Réservé aux comptes connectés, en revanche :
 * une adresse publique qui écrit sur disque laisserait n'importe qui remplir le journal jusqu'à
 * en faire tourner la rotation — et effacer ce qu'il contenait. Une erreur sur la page de
 * connexion reste donc invisible ; c'est le prix, et il est petit.
 *
 * Cette route n'écrit jamais d'erreur à son propre sujet : un rapport qui échoue ne doit pas en
 * produire un autre.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u) return new NextResponse(null, { status: 403 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Rapport illisible" }, { status: 400 });
  }
  logClientError(session.u, { ...body, agent: req.headers.get("user-agent") ?? undefined });
  return NextResponse.json({ ok: true });
}

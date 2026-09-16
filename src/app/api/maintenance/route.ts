import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { maintenanceDb } from "@/lib/db";

/**
 * L'état d'exploitation annoncé aux spectateurs.
 *
 * Lu par tout le monde, écrit par l'administrateur seul. Le second point n'est pas défendu ici :
 * `src/proxy.ts` refuse déjà toute méthode autre que GET sur `/api/` à un compte ordinaire, et
 * cette route n'est pas dans la liste blanche des écritures invitées. Le redire ici serait une
 * seconde règle à maintenir, qui divergerait de la première.
 *
 * `force-dynamic` parce que la réponse est justement ce qui change entre deux requêtes : mise en
 * cache, elle annoncerait la fin de la maintenance pendant toute sa durée.
 */
export const dynamic = "force-dynamic";

async function session(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionFull(token).catch(() => null);
}

export async function GET(req: NextRequest) {
  if (!(await session(req))) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  return NextResponse.json(maintenanceDb.get());
}

/**
 * Deux gestes, pas un.
 *
 * `{ active }` allume ou éteint le bandeau, qui dure. `{ notice: true }` lève un avis daté, qui
 * est ponctuel et n'éteint rien. Les envoyer ensemble est permis et fait les deux : allumer le
 * bandeau *et* prévenir les lecteurs en cours est le geste le plus probable avant un redéploiement.
 */
export async function POST(req: NextRequest) {
  if (!(await session(req))) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { active?: unknown; notice?: unknown } | null;
  if (!body || (typeof body.active !== "boolean" && body.notice !== true)) {
    return NextResponse.json({ error: "Rien à faire : indiquez « active » ou « notice »." }, { status: 400 });
  }

  let state = maintenanceDb.get();
  if (typeof body.active === "boolean") state = maintenanceDb.setActive(body.active);
  if (body.notice === true) state = maintenanceDb.raiseNotice();

  return NextResponse.json(state);
}

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { onboardingDb } from "@/lib/db";

/**
 * L'écran d'accueil du compte connecté : faut-il le proposer, et « c'est fait ».
 *
 * `GET` dit si le marqueur est allumé. `POST` l'éteint — et c'est la seule façon de l'éteindre
 * pour un compte : le bouton de fin de l'accueil. Passer, fermer ou se déconnecter ne l'appellent
 * pas. Voir `onboardingDb`.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  return NextResponse.json({ pending: onboardingDb.isPending(session.u) });
}

export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  onboardingDb.setPending(session.u, false);
  return NextResponse.json({ pending: false });
}

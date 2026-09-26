import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { pushDb } from "@/lib/db";
import { isAllowedPushEndpoint, MAX_PUSH_SUBSCRIPTIONS_PER_USER } from "@/lib/pushEndpoint";

async function getUser(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionFull(token).catch(() => null);
}

export async function POST(req: NextRequest) {
  const session = await getUser(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const endpoint = body?.endpoint as string | undefined;
  const p256dh   = body?.keys?.p256dh as string | undefined;
  const auth     = body?.keys?.auth as string | undefined;

  if (!endpoint || !p256dh || !auth || typeof p256dh !== "string" || typeof auth !== "string") {
    return NextResponse.json({ error: "Subscription invalide" }, { status: 400 });
  }
  // Seulement vers un service push connu : le serveur fait un POST vers cette adresse — voir
  // `isAllowedPushEndpoint`.
  if (!isAllowedPushEndpoint(endpoint) || p256dh.length > 200 || auth.length > 100) {
    return NextResponse.json({ error: "Subscription invalide" }, { status: 400 });
  }

  // Les autres abonnements Apple du compte ne sont plus effacés ici. L'effacement visait les
  // anciens abonnements d'un même appareil, mais il ne savait pas distinguer les appareils : un
  // iPhone et un Mac se désabonnaient l'un l'autre, et le panneau Compte renvoie l'abonnement à
  // chaque ouverture (23/09/2026). Un abonnement périmé répond 410 au premier envoi, et il est
  // alors supprimé (`shouldRemovePushSubscription`).
  pushDb.upsert(session.u, endpoint, p256dh, auth);
  // Rien ne bornait le nombre d'abonnements d'un compte, et chaque notification part vers tous.
  pushDb.trimForUser(session.u, MAX_PUSH_SUBSCRIPTIONS_PER_USER, endpoint);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getUser(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const endpoint = body?.endpoint as string | undefined;

  if (endpoint) {
    // Le sien seulement : l'adresse d'un autre compte n'est pas à ce compte-ci de l'effacer.
    pushDb.removeForUser(session.u, endpoint);
  } else {
    pushDb.removeByUser(session.u);
  }
  return NextResponse.json({ ok: true });
}

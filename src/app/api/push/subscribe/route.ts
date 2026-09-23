import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { pushDb } from "@/lib/db";

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

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "Subscription invalide" }, { status: 400 });
  }

  // Les autres abonnements Apple du compte ne sont plus effacés ici. L'effacement visait les
  // anciens abonnements d'un même appareil, mais il ne savait pas distinguer les appareils : un
  // iPhone et un Mac se désabonnaient l'un l'autre, et le panneau Compte renvoie l'abonnement à
  // chaque ouverture (23/09/2026). Un abonnement périmé répond 410 au premier envoi, et il est
  // alors supprimé (`shouldRemovePushSubscription`).
  pushDb.upsert(session.u, endpoint, p256dh, auth);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getUser(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const endpoint = body?.endpoint as string | undefined;

  if (endpoint) {
    pushDb.remove(endpoint);
  } else {
    pushDb.removeByUser(session.u);
  }
  return NextResponse.json({ ok: true });
}

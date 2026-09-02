import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { trailerDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token).catch(() => null);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
  }

  // Can't enable auto-preview before the local trailer files actually exist — mirrors the
  // settings page's own disabled-toggle state server-side, so this can't be flipped on via a
  // direct API call either.
  if (body.enabled && trailerDb.getLatestJob()?.status !== "done") {
    return NextResponse.json({ error: "Le téléchargement initial des bandes-annonces doit d'abord être terminé" }, { status: 400 });
  }

  trailerDb.setAutoPreviewEnabled(body.enabled);
  return NextResponse.json({ ok: true });
}

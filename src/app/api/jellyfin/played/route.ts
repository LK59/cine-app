import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);

  if (!session?.jfId) {
    return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const itemId = body?.itemId as string | undefined;
  const played = body?.played as boolean | undefined;

  if (!itemId || typeof played !== "boolean") {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  try {
    if (played) {
      await jellyfin.markPlayed(session.jfId, itemId);
    } else {
      await jellyfin.markUnplayed(session.jfId, itemId);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur Jellyfin" },
      { status: 502 }
    );
  }
}

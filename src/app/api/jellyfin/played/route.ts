import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { invalidateKey } from "@/lib/server-cache";


// Le cache de la bibliothèque de cette personne porte `UserData`, donc « vu » et « favori » : le
// laisser tel quel ferait mentir « Ma liste » pendant les deux minutes de son TTL, juste après le
// geste qui l'a changée. Deux clés, celles de cette personne seule.
function invalidateOwnLibrary(userId: string) {
  invalidateKey(`jf:movies:${userId}`);
  invalidateKey(`jf:series:${userId}`);
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

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
    invalidateOwnLibrary(session.jfId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur Jellyfin" },
      { status: 502 }
    );
  }
}

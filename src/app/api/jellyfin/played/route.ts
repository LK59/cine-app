import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { invalidateKey } from "@/lib/server-cache";


// « Ma liste » lit « vu » et « favoris » depuis deux requêtes ciblées, mises en cache : les
// vider ici évite qu'elle contredise, pendant la durée du cache, le geste qui vient de la
// changer. Deux clés, celles de cette personne seule.
function invalidateOwnLibrary(userId: string) {
  invalidateKey(`jf:played:${userId}`);
  invalidateKey(`jf:favorites:${userId}`);
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

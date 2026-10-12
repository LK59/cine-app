import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { newsDb } from "@/lib/news/store";
import { newsAccountNames } from "@/lib/news/admin";

export const dynamic = "force-dynamic";

/**
 * Relancer la fenêtre de la dernière page — pour tous (`all: true`) ou pour un compte (`user`)
 * (DECISIONS.md §73). Pour tous : chaque compte connu de Jellyfin, et ceux de la table ; un compte
 * jamais passé l'a déjà à voir.
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  if (newsDb.latestSeq() === 0) return NextResponse.json({ error: "Aucune page publiée" }, { status: 409 });
  const body = (await req.json().catch(() => null)) as { all?: unknown; user?: unknown } | null;
  if (body?.all === true) {
    const names = await newsAccountNames();
    newsDb.relaunch([...new Set([...names, ...newsDb.states().keys()])]);
    return NextResponse.json({ ok: true });
  }
  if (typeof body?.user === "string" && body.user.trim() !== "") {
    const user = body.user.trim();
    const known = new Set([...(await newsAccountNames()), ...newsDb.states().keys()]);
    if (!known.has(user)) return NextResponse.json({ error: "Compte inconnu" }, { status: 404 });
    newsDb.relaunch([user]);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
}

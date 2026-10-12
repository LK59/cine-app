import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { newsDb } from "@/lib/news/store";
import { logAdminAction } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Publier un brouillon : il prend le numéro suivant, et chaque compte l'a désormais à voir — le
 * drapeau s'allume pour tous sans rien leur écrire (DECISIONS.md §73).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const id = Number((await params).id);
  const seq = Number.isInteger(id) && id > 0 ? newsDb.publish(id) : null;
  if (seq === null) return NextResponse.json({ error: "Page inconnue" }, { status: 404 });
  logAdminAction(session.u, "news-publish", { page: id, seq });
  return NextResponse.json({ ok: true, seq });
}

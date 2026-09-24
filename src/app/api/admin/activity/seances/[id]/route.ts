import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { findSeance } from "@/lib/activity/findSeance";
import { jellyfin } from "@/lib/clients/jellyfin";
import { reportsDb } from "@/lib/db";
import { summarize, whoIs } from "@/lib/reports";

export const dynamic = "force-dynamic";

/**
 * Une séance de lecture, ligne par ligne et en entier : la chronologie de ce qu'a vécu le lecteur,
 * traces comprises — avec la durée du film, qui donne son échelle à la frise, et les tickets qui
 * parlent de cette séance.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const found = findSeance((await params).id);
  if (!found) return NextResponse.json({ error: "Séance introuvable" }, { status: 404 });
  const { seance, lines } = found;
  // La durée du film n'est qu'une échelle : faute de la connaître, la frise s'arrête à la plus
  // grande position vue. Jamais une raison d'échouer.
  let runtime: number | null = null;
  if (seance.itemId) {
    runtime = await jellyfin
      .getItemRunTimeTicks(seance.itemId)
      .then((ticks) => (ticks ? ticks / 10_000_000 : null))
      .catch(() => null);
  }
  const who = whoIs(session);
  const reports = reportsDb.forSeance(seance.id).map((r) => summarize(r, who, "admin"));
  return NextResponse.json({ seance, lines, runtime, reports });
}

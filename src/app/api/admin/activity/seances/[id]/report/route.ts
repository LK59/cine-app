import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { findSeance } from "@/lib/activity/findSeance";
import { jellyfin } from "@/lib/clients/jellyfin";
import { reportsDb } from "@/lib/db";
import { detail, LIMITS, markSeenBy, notifyAuthor, whoIs } from "@/lib/reports";
import { captureReportLogs } from "@/lib/reportLogs";

export const dynamic = "force-dynamic";

/**
 * Écrire à quelqu'un depuis une séance qui s'est mal passée : l'administrateur ouvre un ticket à
 * son nom, lié à la séance, avec les journaux du moment. La personne le trouve dans « Mes
 * signalements », avec sa pastille, et y répond comme à un autre.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, LIMITS.MAX_DESCRIPTION) : "";
  if (!message) return NextResponse.json({ error: "Message vide" }, { status: 400 });
  const found = findSeance((await params).id);
  if (!found) return NextResponse.json({ error: "Séance introuvable" }, { status: 404 });
  const { seance } = found;

  // Le ticket appartient à la personne : il lui faut son identifiant Jellyfin, celui sous lequel
  // ses propres signalements sont rangés. Le journal ne porte que son nom.
  const users = await jellyfin.getUsers().catch(() => null);
  if (!users) return NextResponse.json({ error: "Serveur média injoignable" }, { status: 502 });
  const user = users.find((u) => u.Name?.toLowerCase() === seance.user.toLowerCase());
  if (!user?.Id || !user.Name) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });

  const report = reportsDb.openForUser(
    user.Id,
    user.Name,
    {
      zone: "player",
      element: null,
      elementOther: null,
      issue: null,
      issueOther: null,
      itemId: seance.itemId,
      itemTitle: seance.title,
      itemKind: null,
      description: message,
    },
    seance.id,
    captureReportLogs(user.Name, { id: seance.itemId, title: seance.title })
  );
  const who = whoIs(session);
  markSeenBy(report, who);
  void notifyAuthor(report, "opened");
  return NextResponse.json(detail(reportsDb.get(report.id)!, who), { status: 201 });
}

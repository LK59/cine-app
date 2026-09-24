import { NextRequest, NextResponse } from "next/server";
import { reportsDb, type ReportStatus } from "@/lib/db";
import { canSetStatus, detail, isOwner, notifyAdmin, notifyAuthor } from "@/lib/reports";
import { reportCaller, reportFor } from "@/lib/reportRequest";

export const dynamic = "force-dynamic";

const STATUSES: ReportStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * Changer l'état : l'administrateur en tout sens, l'auteur pour fermer — ou rouvrir un signalement
 * résolu ou fermé. Le changement s'inscrit dans le fil, et l'autre côté en est prévenu.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const report = reportFor((await params).id, who);
  if (report instanceof NextResponse) return report;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  const next = STATUSES.find((s) => s === body?.status);
  if (!next || !canSetStatus(report, who, next)) return NextResponse.json({ error: "Changement refusé" }, { status: 403 });

  const byAuthor = isOwner(report, who);
  reportsDb.setStatus(report.id, next, byAuthor ? "user" : "admin");
  reportsDb.addMessage(report.id, "system", who.userName, `status:${next}`);
  reportsDb.markSeen(report.id, byAuthor ? "user" : "admin");
  const updated = reportsDb.get(report.id)!;
  if (byAuthor) void notifyAdmin(updated, "status");
  else void notifyAuthor(updated, "status");
  return NextResponse.json(detail(updated, who));
}

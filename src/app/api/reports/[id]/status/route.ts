import { NextRequest, NextResponse } from "next/server";
import { reportsDb, type ReportStatus } from "@/lib/db";
import { canSetStatus, detail, isOwner, markSeenBy, notifyAdmin, notifyAuthor } from "@/lib/reports";
import { reportCaller, reportError, reportFor } from "@/lib/reportRequest";

export const dynamic = "force-dynamic";

const STATUSES: ReportStatus[] = ["open", "in_progress", "resolved", "closed"];

/**
 * Changer l'état : l'administrateur en tout sens, l'auteur pour fermer — ou rouvrir un signalement
 * résolu ou fermé. Le changement s'inscrit dans le fil, et l'autre côté en est prévenu — sauf d'une fermeture.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const report = reportFor((await params).id, who);
  if (report instanceof NextResponse) return report;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  const next = STATUSES.find((s) => s === body?.status);
  if (!next || !canSetStatus(report, who, next)) return reportError("refused", 403, "Changement refusé");

  const byAuthor = isOwner(report, who);
  // Une fermeture ne réclame l'attention de personne : ni pastille, ni notification, de quelque
  // côté qu'elle vienne. Elle reste écrite dans le fil.
  const quiet = next === "closed";
  reportsDb.setStatus(report.id, next, byAuthor ? "user" : "admin", quiet);
  reportsDb.addMessage(report.id, "system", who.userName, `status:${next}`);
  const updated = reportsDb.get(report.id)!;
  markSeenBy(updated, who);
  if (!quiet) {
    if (byAuthor) void notifyAdmin(updated, "status");
    else void notifyAuthor(updated, "status");
  }
  return NextResponse.json(detail(updated, who));
}

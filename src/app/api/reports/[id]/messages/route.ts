import { NextRequest, NextResponse } from "next/server";
import { reportsDb } from "@/lib/db";
import { detail, isOwner, LIMITS, markSeenBy, notifyAdmin, notifyAuthor } from "@/lib/reports";
import { imagesFromForm, saveReportImage } from "@/lib/reportImages";
import { reportCaller, reportError, reportFor } from "@/lib/reportRequest";
import { MAX_IMAGES_PER_REPORT } from "@/lib/reportLimits";

export const dynamic = "force-dynamic";

/**
 * Un commentaire — de l'auteur ou de l'administrateur —, images comprises. L'autre côté est
 * prévenu, et sa pastille s'allume.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const report = reportFor((await params).id, who);
  if (report instanceof NextResponse) return report;
  if (report.status === "draft") return reportError("draftNoComment", 409, "Un brouillon ne se commente pas");
  const form = await req.formData().catch(() => null);
  if (!form) return reportError("form", 400, "Formulaire illisible");
  const body = typeof form.get("body") === "string" ? String(form.get("body")).trim().slice(0, LIMITS.MAX_MESSAGE) : "";
  const images = imagesFromForm(form);
  if ("code" in images) return reportError(images.code, 400, images.detail);
  if (!body && images.length === 0) return reportError("empty", 400, "Message vide");
  // Un plafond par signalement, commentaires compris : sans lui, un fil pouvait remplir `data/`,
  // le seul volume inscriptible, qui porte aussi la base et les journaux (relu le 24/09/2026).
  if (reportsDb.images(report.id).length + images.length > MAX_IMAGES_PER_REPORT) {
    return reportError("tooMany", 400, `${MAX_IMAGES_PER_REPORT} images au plus par signalement`);
  }

  const byAuthor = isOwner(report, who);
  const message = reportsDb.addMessage(report.id, byAuthor ? "user" : "admin", who.userName, body);
  for (const image of images) await saveReportImage(report.id, message.id, image.original, image.shown);
  const updated = reportsDb.get(report.id)!;
  markSeenBy(updated, who);
  if (byAuthor) void notifyAdmin(updated, "comment");
  else void notifyAuthor(updated, "reply");
  return NextResponse.json(detail(updated, who), { status: 201 });
}

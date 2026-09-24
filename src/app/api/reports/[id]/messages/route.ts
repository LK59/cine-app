import { NextRequest, NextResponse } from "next/server";
import { reportsDb } from "@/lib/db";
import { detail, isOwner, LIMITS, markSeenBy, notifyAdmin, notifyAuthor } from "@/lib/reports";
import { imagesFromForm, saveReportImage } from "@/lib/reportImages";
import { reportCaller, reportFor } from "@/lib/reportRequest";

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
  if (report.status === "draft") return NextResponse.json({ error: "Un brouillon ne se commente pas" }, { status: 409 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Formulaire illisible" }, { status: 400 });
  const body = typeof form.get("body") === "string" ? String(form.get("body")).trim().slice(0, LIMITS.MAX_MESSAGE) : "";
  const images = imagesFromForm(form);
  if (typeof images === "string") return NextResponse.json({ error: images }, { status: 400 });
  if (!body && images.length === 0) return NextResponse.json({ error: "Message vide" }, { status: 400 });

  const byAuthor = isOwner(report, who);
  const message = reportsDb.addMessage(report.id, byAuthor ? "user" : "admin", who.userName, body);
  for (const image of images) await saveReportImage(report.id, message.id, image.original, image.shown);
  const updated = reportsDb.get(report.id)!;
  markSeenBy(updated, who);
  if (byAuthor) void notifyAdmin(updated, "comment");
  else void notifyAuthor(updated, "reply");
  return NextResponse.json(detail(updated, who), { status: 201 });
}

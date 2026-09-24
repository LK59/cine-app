import { NextRequest, NextResponse } from "next/server";
import { reportsDb } from "@/lib/db";
import { detail, markSeenBy, notifyAdmin, seanceFor, readContext, readFields, summarize } from "@/lib/reports";
import { imagesFromForm, saveReportImage } from "@/lib/reportImages";
import { captureReportLogs } from "@/lib/reportLogs";
import { jsonField, reportCaller, reportError } from "@/lib/reportRequest";

export const dynamic = "force-dynamic";

/** Mes signalements, brouillons compris, les plus récents d'abord. */
export async function GET(req: NextRequest) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  return NextResponse.json({ reports: reportsDb.listForUser(who.userId).map((r) => summarize(r, who)) });
}

/**
 * Créer un signalement — envoyé, ou gardé en brouillon (`draft`). Un formulaire : `report` (le JSON
 * des choix et du texte), `context`, et les images (`images`, avec `shown` au même rang quand le
 * navigateur a dû convertir). À l'envoi, les journaux de la personne sont figés avec lui et
 * l'administrateur est prévenu.
 */
export async function POST(req: NextRequest) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const form = await req.formData().catch(() => null);
  if (!form) return reportError("form", 400, "Formulaire illisible");
  const draft = form.get("draft") === "1";
  const fields = readFields(jsonField(form, "report"), draft);
  if (typeof fields === "string") return reportError("incomplete", 400, fields);
  const images = imagesFromForm(form);
  if ("code" in images) return reportError(images.code, 400, images.detail);

  const report = reportsDb.create(who.userId, who.userName, fields, draft, readContext(jsonField(form, "context"), req.headers.get("user-agent")));
  for (const image of images) await saveReportImage(report.id, null, image.original, image.shown);
  if (!draft) {
    const logs = captureReportLogs(who.userName, { id: fields.itemId, title: fields.itemTitle });
    reportsDb.setLogs(report.id, logs);
    reportsDb.setSeance(report.id, seanceFor(fields, logs));
    markSeenBy(report, who);
    void notifyAdmin(report, "new");
  }
  return NextResponse.json(detail(reportsDb.get(report.id)!, who), { status: 201 });
}

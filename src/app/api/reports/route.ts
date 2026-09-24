import { NextRequest, NextResponse } from "next/server";
import { reportsDb } from "@/lib/db";
import { detail, notifyAdmin, readContext, readFields, summarize } from "@/lib/reports";
import { imagesFromForm, saveReportImage } from "@/lib/reportImages";
import { captureReportLogs } from "@/lib/reportLogs";
import { jsonField, reportCaller } from "@/lib/reportRequest";

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
  if (!form) return NextResponse.json({ error: "Formulaire illisible" }, { status: 400 });
  const draft = form.get("draft") === "1";
  const fields = readFields(jsonField(form, "report"), draft);
  if (typeof fields === "string") return NextResponse.json({ error: fields }, { status: 400 });
  const images = imagesFromForm(form);
  if (typeof images === "string") return NextResponse.json({ error: images }, { status: 400 });

  const report = reportsDb.create(who.userId, who.userName, fields, draft, readContext(jsonField(form, "context"), req.headers.get("user-agent")));
  for (const image of images) await saveReportImage(report.id, null, image.original, image.shown);
  if (!draft) {
    reportsDb.setLogs(report.id, captureReportLogs(who.userName, { id: fields.itemId, title: fields.itemTitle }));
    void notifyAdmin(report, "new");
  }
  return NextResponse.json(detail(reportsDb.get(report.id)!, who), { status: 201 });
}

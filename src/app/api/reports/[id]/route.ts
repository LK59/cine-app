import { NextRequest, NextResponse } from "next/server";
import { reportsDb } from "@/lib/db";
import { detail, isOwner, notifyAdmin, readContext, readFields } from "@/lib/reports";
import { imagesFromForm, saveReportImage } from "@/lib/reportImages";
import { captureReportLogs } from "@/lib/reportLogs";
import { jsonField, reportCaller, reportFor } from "@/lib/reportRequest";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Un signalement, ses échanges et ses images. L'ouvrir le marque lu pour qui l'ouvre. */
export async function GET(req: NextRequest, { params }: Params) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const report = reportFor((await params).id, who);
  if (report instanceof NextResponse) return report;
  if (report.status !== "draft") reportsDb.markSeen(report.id, isOwner(report, who) ? "user" : "admin");
  return NextResponse.json(detail(report, who));
}

/**
 * Modifier un brouillon — ses choix, son texte, des images en plus — et, avec `send=1`, l'envoyer.
 * Un signalement envoyé ne se réécrit plus : on y ajoute un commentaire.
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const report = reportFor((await params).id, who);
  if (report instanceof NextResponse) return report;
  if (!isOwner(report, who) || report.status !== "draft") {
    return NextResponse.json({ error: "Seul un brouillon se modifie" }, { status: 409 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Formulaire illisible" }, { status: 400 });
  const send = form.get("send") === "1";
  const fields = readFields(jsonField(form, "report"), !send);
  if (typeof fields === "string") return NextResponse.json({ error: fields }, { status: 400 });
  const images = imagesFromForm(form);
  if (typeof images === "string") return NextResponse.json({ error: images }, { status: 400 });
  if (reportsDb.images(report.id).length + images.length > 12) {
    return NextResponse.json({ error: "12 images au plus par signalement" }, { status: 400 });
  }

  reportsDb.updateDraft(report.id, fields, readContext(jsonField(form, "context"), req.headers.get("user-agent")));
  for (const image of images) await saveReportImage(report.id, null, image.original, image.shown);
  if (send) {
    reportsDb.send(report.id, captureReportLogs(who.userName, { id: fields.itemId, title: fields.itemTitle }));
    void notifyAdmin(reportsDb.get(report.id)!, "new");
  }
  return NextResponse.json(detail(reportsDb.get(report.id)!, who));
}

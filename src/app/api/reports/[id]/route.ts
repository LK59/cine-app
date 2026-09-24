import { NextRequest, NextResponse } from "next/server";
import { reportsDb } from "@/lib/db";
import { detail, isOwner, markSeenBy, notifyAdmin, seanceFor, readContext, readFields } from "@/lib/reports";
import fs from "node:fs";
import path from "node:path";
import { imagesFromForm, REPORTS_DIR, saveReportImage } from "@/lib/reportImages";
import { MAX_IMAGES_PER_REPORT } from "@/lib/reportLimits";
import { captureReportLogs } from "@/lib/reportLogs";
import { jsonField, reportCaller, reportError, reportFor } from "@/lib/reportRequest";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Un signalement, ses échanges et ses images. L'ouvrir le marque lu pour qui l'ouvre. */
export async function GET(req: NextRequest, { params }: Params) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const report = reportFor((await params).id, who);
  if (report instanceof NextResponse) return report;
  markSeenBy(report, who);
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
  if (!isOwner(report, who) || report.status !== "draft") return reportError("notDraft", 409, "Seul un brouillon se modifie");
  const form = await req.formData().catch(() => null);
  if (!form) return reportError("form", 400, "Formulaire illisible");
  // Relu après la lecture du formulaire, qui peut prendre des secondes sur un réseau mobile : un
  // envoi parallèle du même brouillon a pu partir pendant ce temps.
  if (reportsDb.get(report.id)?.status !== "draft") return reportError("notDraft", 409, "Seul un brouillon se modifie");
  const send = form.get("send") === "1";
  const fields = readFields(jsonField(form, "report"), !send);
  if (typeof fields === "string") return reportError("incomplete", 400, fields);
  const images = imagesFromForm(form);
  if ("code" in images) return reportError(images.code, 400, images.detail);
  if (reportsDb.images(report.id).length + images.length > MAX_IMAGES_PER_REPORT) {
    return reportError("tooMany", 400, `${MAX_IMAGES_PER_REPORT} images au plus par signalement`);
  }

  reportsDb.updateDraft(report.id, fields, readContext(jsonField(form, "context"), req.headers.get("user-agent")));
  for (const image of images) await saveReportImage(report.id, null, image.original, image.shown);
  if (send) {
    const logs = captureReportLogs(who.userName, { id: fields.itemId, title: fields.itemTitle });
    if (reportsDb.send(report.id, logs)) {
      reportsDb.setSeance(report.id, seanceFor(fields, logs));
      const sent = reportsDb.get(report.id)!;
      markSeenBy(sent, who);
      void notifyAdmin(sent, "new");
    }
  }
  return NextResponse.json(detail(reportsDb.get(report.id)!, who));
}

/**
 * Supprimer un brouillon, par son auteur. Un brouillon créé par erreur restait pour toujours dans
 * « Mes signalements », ses images sur le disque (relu le 24/09/2026). Un signalement envoyé, lui,
 * ne se supprime pas : on le ferme.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const report = reportFor((await params).id, who);
  if (report instanceof NextResponse) return report;
  if (!isOwner(report, who) || !reportsDb.deleteDraft(report.id)) return reportError("notDraft", 409, "Seul un brouillon se supprime");
  fs.rmSync(path.join(REPORTS_DIR(), String(report.id)), { recursive: true, force: true });
  return NextResponse.json({ ok: true });
}

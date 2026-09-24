import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { reportsDb } from "@/lib/db";
import { isOwner } from "@/lib/reports";
import { reportFilePath, storedImageType } from "@/lib/reportImages";
import { reportCaller, reportFor } from "@/lib/reportRequest";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; imageId: string }> };

/**
 * Une capture : la version d'affichage, ou l'original avec `?original=1`. Servie à l'auteur et à
 * l'administrateur seulement — une capture montre l'écran de quelqu'un.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const { id, imageId } = await params;
  const report = reportFor(id, who);
  if (report instanceof NextResponse) return report;
  const image = reportsDb.images(report.id).find((i) => i.id === Number(imageId));
  if (!image) return NextResponse.json({ error: "Image introuvable" }, { status: 404 });
  const original = req.nextUrl.searchParams.get("original") === "1" || !image.file;
  const file = reportFilePath(report.id, original ? image.original : image.file!);
  if (!file || !fs.existsSync(file)) return NextResponse.json({ error: "Image introuvable" }, { status: 404 });
  const name = (image.originalName ?? "capture").replace(/[^\w.\- ]/g, "_");
  return new NextResponse(fs.readFileSync(file), {
    headers: {
      // Le type par l'extension enregistrée, pas celui que la ligne a gardé du navigateur : les
      // lignes d'avant le correctif portent encore le type annoncé à l'envoi.
      "Content-Type": original ? storedImageType(image.original) : "image/webp",
      "X-Content-Type-Options": "nosniff",
      // Le bac à sable (`sandbox`) est posé par next.config.js : un en-tête de politique posé ici
      // serait écrasé par la règle générale du site.
      "Cache-Control": "private, max-age=31536000, immutable",
      ...(original ? { "Content-Disposition": `inline; filename="${name}"` } : {}),
    },
  });
}

/** Retirer une image d'un brouillon, par son auteur. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const who = await reportCaller(req);
  if (who instanceof NextResponse) return who;
  const { id, imageId } = await params;
  const report = reportFor(id, who);
  if (report instanceof NextResponse) return report;
  if (!isOwner(report, who)) return NextResponse.json({ error: "Refusé" }, { status: 403 });
  const removed = reportsDb.removeDraftImage(report.id, Number(imageId));
  if (!removed) return NextResponse.json({ error: "Seul un brouillon perd ses images" }, { status: 409 });
  for (const name of [removed.original, removed.file]) {
    const file = name ? reportFilePath(report.id, name) : null;
    if (file) fs.rmSync(file, { force: true });
  }
  return NextResponse.json({ ok: true });
}

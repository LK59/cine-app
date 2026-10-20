import { NextRequest, NextResponse } from "next/server";
import { assertVisible } from "@/lib/itemVisibility";
import { JOB_ID, callerOf } from "@/lib/subtitleGen/request";
import { jobsDb } from "@/lib/subtitleGen/store";
import { readFinal } from "@/lib/subtitleGen/files";

/**
 * Le WebVTT d'une tâche terminée, depuis `data/subtitles` (DECISIONS.md §69). Session exigée : pas
 * de laissez-passer de diffusion ici — l'adresse ne porte pas le titre, que `castPassFor` lit dans
 * le chemin ; un téléviseur reçoit le sous-titre par Jellyfin une fois qu'il y est présenté.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const jobId = file.replace(/\.vtt$/, "");
  if (!file.endsWith(".vtt") || !JOB_ID.test(jobId)) return new NextResponse(null, { status: 400 });
  const who = await callerOf(req);
  if (!who) return new NextResponse(null, { status: 401 });
  const job = jobsDb.get(jobId);
  if (!job || job.status !== "done") return new NextResponse(null, { status: 404 });
  const refused = await assertVisible(who.session, job.item_id);
  if (refused) return refused;
  const text = readFinal(job.item_id, job.id, job.target, "vtt");
  if (text === null) return new NextResponse(null, { status: 404 });
  // `no-cache` (revue de sécurité du 20/10/2026) : gardé une heure, le sous-titre se resservait
  // depuis le cache du navigateur à un autre compte du même appareil, sans repasser par
  // `assertVisible` — les tags bloqués d'un compte ne valaient plus. Un fichier de quelques
  // dizaines de Ko, relu à chaque ouverture : pas d'étiquette à tenir pour si peu.
  return new NextResponse(text, { headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "private, no-cache" } });
}

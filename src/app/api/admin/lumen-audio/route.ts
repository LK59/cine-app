import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { config } from "@/lib/config";
import { detectLumenFfmpeg } from "@/lib/lumenServer/audio/ffmpeg";
import { lumenAudio } from "@/lib/lumenServer/audio/conversion";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };

/**
 * L'état de la conversion du son de Lumen serveur (DECISIONS.md §161), pour la carte de la Configuration : ffmpeg
 * détecté ou pourquoi pas (version, empreinte, encodeurs), l'option, la file et les lectures qui convertissent,
 * l'occupation du cache (mémoire, disque), et les 24 dernières heures. `POST { action: "detect" }` refait la
 * détection (après un changement de `LUMEN_FFMPEG_PATH`, un binaire remplacé). Administrateur seul : `adminOnly` ici,
 * et `/api/admin/lumen-audio` dans `ADMIN_ONLY_READS`. Rien n'y est lancé d'autre que `ffmpeg -version` et ses
 * listes : la conversion elle-même ne part que d'une requête de lecture.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const detection = await detectLumenFfmpeg();
  return NextResponse.json(statusOf(detection), { headers: PRIVATE });
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "detect") return NextResponse.json({ error: "invalid" }, { status: 400, headers: PRIVATE });
  return NextResponse.json(statusOf(await detectLumenFfmpeg({ force: true })), { headers: PRIVATE });
}

function statusOf(detection: Awaited<ReturnType<typeof detectLumenFfmpeg>>) {
  // L'empreinte complète et le chemin ne servent qu'à l'administrateur ; jamais de trame de référence en clair.
  const ffmpeg = detection.available
    ? { available: true, path: detection.path, version: detection.version, sha256: detection.sha256.slice(0, 16), encoders: detection.encoders, ms: detection.ms }
    : { available: false, path: detection.path, reason: detection.reason, version: detection.version ?? null };
  return { audience: config.lumen.audioConvert, ffmpeg, ...lumenAudio().status() };
}

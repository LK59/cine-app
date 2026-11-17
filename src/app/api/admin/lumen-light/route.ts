import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { config } from "@/lib/config";
import { detectLightEncoder } from "@/lib/lumenServer/light/encoder";
import { lightStats } from "@/lib/lumenServer/light/service";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };

/**
 * L'état de la version allégée de Lumen serveur (`lumenServer/light/`), pour la carte de la Configuration : l'encodeur
 * (ffmpeg vidéo, VAAPI, le iGPU) détecté ou pourquoi pas, l'option, et ce que le processus a fait (encodés, servis de la
 * mémoire ou du disque, en échec, la file). `POST { action: "detect" }` refait la détection (après avoir donné
 * `/dev/dri` au conteneur, un pilote changé). Administrateur seul : `adminOnly` ici, et `/api/admin/lumen-light` dans
 * `ADMIN_ONLY_READS`. La détection encode deux images d'une mire, une fois ; rien d'autre n'est lancé d'ici.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  return NextResponse.json(statusOf(await detectLightEncoder()), { headers: PRIVATE });
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "detect") return NextResponse.json({ error: "invalid" }, { status: 400, headers: PRIVATE });
  return NextResponse.json(statusOf(await detectLightEncoder({ force: true })), { headers: PRIVATE });
}

function statusOf(detection: Awaited<ReturnType<typeof detectLightEncoder>>) {
  const encoder = detection.available
    ? { available: true, version: detection.version, driver: detection.driver, ms: detection.ms }
    : { available: false, reason: detection.reason };
  const s = lightStats();
  return { audience: config.lumen.light, encoder, stats: { built: s.built, ram: s.ram, disk: s.disk, failed: s.failed, running: s.running, queued: s.queued } };
}

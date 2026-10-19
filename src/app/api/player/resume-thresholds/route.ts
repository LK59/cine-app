import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { resumeThresholds } from "@/lib/playbackReport";

/**
 * Les seuils de reprise de Jellyfin, pour l'appareil : le lecteur des téléchargements applique hors
 * ligne exactement la règle que Jellyfin applique à un arrêt (Louis, 19/10/2026 — « toutes ces
 * règles doivent être appliquées à la reprise locale »). Gardés sur l'appareil pour quand il n'y a
 * pas de réseau (`offline/resumeRules.ts`).
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new NextResponse(null, { status: 401 });
  return NextResponse.json(await resumeThresholds(), { headers: { "Cache-Control": "private, max-age=600" } });
}

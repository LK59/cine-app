import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { DATA_DIR } from "@/lib/dataDir";
import { LAB_SAMPLES } from "@/lib/labSamples";

/**
 * Les extraits du test de qualité hors ligne présents sur le disque, avec leur taille — voir
 * `labSamples.ts`. Réservé à l'administrateur, vérifié ici : le proxy laisse lire tout le monde.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (session?.role !== "admin") return new NextResponse(null, { status: 403 });
  const dir = path.join(DATA_DIR, "lab", "offline-samples");
  const samples = LAB_SAMPLES.flatMap((s) => {
    try {
      return [{ file: s.file, sizeBytes: fs.statSync(path.join(dir, s.file)).size }];
    } catch {
      return [];
    }
  });
  return NextResponse.json({ samples }, { headers: { "Cache-Control": "private, no-store" } });
}

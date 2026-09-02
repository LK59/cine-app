import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { runTrailerJob, isTrailerJobRunning } from "@/lib/trailerJob";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token).catch(() => null);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  if (isTrailerJobRunning()) {
    return NextResponse.json({ error: "Un téléchargement est déjà en cours" }, { status: 409 });
  }

  // Fire-and-forget — the job can take a long time (hundreds of downloads), the settings page
  // polls /status for progress instead of waiting on this request. Same pattern disk-stats.ts's
  // triggerCompute() already uses.
  runTrailerJob("full").catch(() => {});
  return NextResponse.json({ ok: true });
}

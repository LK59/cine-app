import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { trailerDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token).catch(() => null);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const { autoPreviewEnabled } = trailerDb.getSettings();
  const job = trailerDb.getLatestJob();

  return NextResponse.json({
    autoPreviewEnabled,
    job: job ? { status: job.status, total: job.total, completed: job.completed, failed: job.failed } : null,
  });
}

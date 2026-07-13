import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { checkWatchlistAvailability, checkNewEpisodes } from "@/lib/notificationJobs";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token).catch(() => null);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  await Promise.all([checkWatchlistAvailability(), checkNewEpisodes()]);
  return NextResponse.json({ ok: true });
}

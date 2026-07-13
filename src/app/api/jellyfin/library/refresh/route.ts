import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import { withErrorHandling } from "@/lib/api-helpers";
import { NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Réservé à l'administrateur" }, { status: 403 });
  }
  return withErrorHandling(async () => {
    await jellyfin.refreshLibrary();
    return { ok: true };
  });
}

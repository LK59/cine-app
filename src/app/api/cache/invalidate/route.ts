import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { invalidateLibrary } from "@/lib/server-cache";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Réservé à l'administrateur" }, { status: 403 });
  }
  invalidateLibrary();
  return NextResponse.json({ ok: true });
}

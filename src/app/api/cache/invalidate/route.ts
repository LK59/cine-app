import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { invalidateLibrary } from "@/lib/server-cache";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Réservé à l'administrateur" }, { status: 403 });
  }
  invalidateLibrary();
  return NextResponse.json({ ok: true });
}

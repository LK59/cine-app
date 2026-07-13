import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ username: session.u, role: session.role, jfId: session.jfId ?? null, jfUser: session.jfUser ?? null });
}

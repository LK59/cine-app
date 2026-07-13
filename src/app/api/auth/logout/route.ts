import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { sessionDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  // Verify without DB check so we can still extract the jti even if it's already been removed
  if (token) {
    try {
      const dotIndex = token.indexOf(".");
      if (dotIndex !== -1) {
        const payload = JSON.parse(atob(token.slice(0, dotIndex).replace(/-/g, "+").replace(/_/g, "/")));
        if (payload?.jti) sessionDb.delete(payload.jti);
      }
    } catch { /* ignore parse errors */ }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}

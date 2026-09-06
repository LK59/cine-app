import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";
import { sessionDb, userPrefsDb } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimiter";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { getClientIp } from "@/lib/api-helpers";
import { timingSafeEquals } from "@/lib/timingSafeEquals";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: "Trop de tentatives, réessayez dans 15 minutes" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const username = body?.username as string | undefined;
  const password = body?.password as string | undefined;

  if (!username || !password) {
    return NextResponse.json({ error: "Identifiants requis" }, { status: 400 });
  }

  const isAdmin =
    username === config.app.adminUser &&
    !!config.app.adminPassword &&
    timingSafeEquals(password, config.app.adminPassword);

  if (!isAdmin) {
    return NextResponse.json({ error: "Identifiants invalides" }, { status: 401 });
  }

  const { token, jti } = await createSessionToken(username, "admin");
  sessionDb.create(jti, username);
  const lang = userPrefsDb.getLang(username, config.app.language);
  const res = NextResponse.json({ ok: true, role: "admin" });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.app.cookieSecure,
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  res.cookies.set(LOCALE_COOKIE, lang, {
    sameSite: "lax",
    secure: config.app.cookieSecure,
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}

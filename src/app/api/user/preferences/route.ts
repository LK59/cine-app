import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { userPrefsDb } from "@/lib/db";
import { config } from "@/lib/config";
import { LOCALE_COOKIE, LOCALES, type Locale } from "@/lib/i18n";

export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = session.jfId ?? session.u;
  const lang = userPrefsDb.getLang(userId, config.app.language);
  return NextResponse.json({ lang });
}

export async function PUT(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const lang = body?.lang as string | undefined;
  if (!lang || !LOCALES.includes(lang as Locale)) {
    return NextResponse.json({ error: "invalid lang" }, { status: 400 });
  }

  const userId = session.jfId ?? session.u;
  userPrefsDb.setLang(userId, lang);

  const res = NextResponse.json({ ok: true, lang });
  res.cookies.set(LOCALE_COOKIE, lang, {
    sameSite: "lax",
    secure: config.app.cookieSecure,
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return res;
}

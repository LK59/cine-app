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
  // Reported to every caller, but only ever true for an admin who turned it on: the PUT below
  // refuses to set it for anyone else, so a non-admin can't end up with it enabled.
  const experimentalPlayer = userPrefsDb.getExperimentalPlayer(userId);
  return NextResponse.json({ lang, experimentalPlayer });
}

export async function PUT(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const userId = session.jfId ?? session.u;

  // The experimental player is its own update: it has no locale to write, and it is
  // admin-only — a body carrying it is rejected outright for anyone else rather than silently
  // ignored, so the caller learns the setting did not take.
  if (typeof body?.experimentalPlayer === "boolean" || typeof body?.experimentalPlayerHdr === "boolean") {
    if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const current = userPrefsDb.getExperimentalPlayer(userId);
    const enabled = typeof body.experimentalPlayer === "boolean" ? body.experimentalPlayer : current.enabled;
    // Turning the player off turns HDR off with it: an HDR flag on a disabled player is a
    // setting that reads as active and does nothing.
    const hdr = enabled && (typeof body.experimentalPlayerHdr === "boolean" ? body.experimentalPlayerHdr : current.hdr);
    userPrefsDb.setExperimentalPlayer(userId, enabled, hdr);
    return NextResponse.json({ ok: true, experimentalPlayer: { enabled, hdr } });
  }

  const lang = body?.lang as string | undefined;
  if (!lang || !LOCALES.includes(lang as Locale)) {
    return NextResponse.json({ error: "invalid lang" }, { status: 400 });
  }

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

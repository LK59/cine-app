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
  const legacyPlayer = userPrefsDb.getLegacyPlayer(userId);
  const guidedScroll = userPrefsDb.getGuidedScroll(userId);
  // La disposition de l'accueil (DECISIONS.md §52) : ce que le compte a choisi (`null` = rien),
  // et ce que le serveur donne par défaut — l'écran du Compte montre les deux.
  const own = userPrefsDb.getHomeLayout(userId);
  const homeDefaults = { browseButton: config.home.browseButton, continueHero: config.home.continueHero };
  return NextResponse.json({ lang, legacyPlayer, guidedScroll, homeOwn: own, homeDefaults });
}

export async function PUT(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const userId = session.jfId ?? session.u;

  // The experimental player is its own update: it has no locale to write, and it is one flag
  // rather than two now — converting HDR on the GPU was a consent gate for the fallback, and the
  // native path carries HDR through untouched.
  //
  // No longer admin-only, either. The setting was opened to every account, and leaving this
  // check behind meant the toggle appeared for everyone and answered 403 to all but one of them.
  if (typeof body?.legacyPlayer === "boolean") {
    userPrefsDb.setLegacyPlayer(userId, body.legacyPlayer);
    return NextResponse.json({ ok: true, legacyPlayer: { enabled: body.legacyPlayer } });
  }

  // Le défilement guidé (DECISIONS.md §50) : une mise à jour à elle seule, comme la précédente.
  if (typeof body?.guidedScroll === "boolean") {
    userPrefsDb.setGuidedScroll(userId, body.guidedScroll);
    return NextResponse.json({ ok: true, guidedScroll: body.guidedScroll });
  }

  // La disposition de l'accueil : un booléen choisit, `null` rend la main au serveur.
  if (body?.home && typeof body.home === "object") {
    const changed: Record<string, boolean | null> = {};
    for (const key of ["browseButton", "continueHero"] as const) {
      const value = body.home[key];
      if (value === null || typeof value === "boolean") {
        userPrefsDb.setHomeLayout(userId, key, value);
        changed[key] = value;
      }
    }
    if (Object.keys(changed).length === 0) return NextResponse.json({ error: "invalid home" }, { status: 400 });
    return NextResponse.json({ ok: true, home: changed });
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

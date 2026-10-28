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
  const guidedScroll = userPrefsDb.getGuidedScroll(userId);
  // La disposition de l'accueil (DECISIONS.md §52) : ce que le compte a choisi (`null` = rien),
  // et ce que le serveur donne par défaut — l'écran du Compte montre les deux.
  const own = userPrefsDb.getHomeLayout(userId);
  const homeDefaults = { continueHero: config.home.continueHero };
  // « Afficher les livres » (DECISIONS.md §127), suivi d'un appareil à l'autre comme le reste.
  const showBooks = userPrefsDb.getShowBooks(userId);
  return NextResponse.json({ lang, guidedScroll, showBooks, homeOwn: own, homeDefaults });
}

export async function PUT(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const userId = session.jfId ?? session.u;

  // `legacyPlayer` n'est plus accepté (13/10/2026) : le lecteur legacy par compte a disparu. Une
  // demande qui le porte encore tombe sur la validation de la langue ci-dessous (400), sans rien
  // écrire.

  // Le défilement guidé (DECISIONS.md §50) : une mise à jour à elle seule.
  if (typeof body?.guidedScroll === "boolean") {
    userPrefsDb.setGuidedScroll(userId, body.guidedScroll);
    return NextResponse.json({ ok: true, guidedScroll: body.guidedScroll });
  }

  // « Afficher les livres » (DECISIONS.md §127) : une mise à jour à elle seule.
  if (typeof body?.showBooks === "boolean") {
    userPrefsDb.setShowBooks(userId, body.showBooks);
    return NextResponse.json({ ok: true, showBooks: body.showBooks });
  }

  // La disposition de l'accueil : un booléen choisit, `null` rend la main au serveur.
  if (body?.home && typeof body.home === "object") {
    const changed: Record<string, boolean | null> = {};
    // `browseButton` n'est plus accepté (13/10/2026) : le bouton est toujours affiché. Un vieux
    // client qui l'envoie seul reçoit un 400 sans que rien ne soit écrit.
    for (const key of ["continueHero"] as const) {
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

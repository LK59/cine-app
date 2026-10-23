import type { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";
import { LOCALE_COOKIE } from "@/lib/i18n";

/**
 * Les deux cookies d'une connexion réussie — la session et la langue du compte —, écrits une fois.
 *
 * Trois chemins ouvrent une session du foyer : la connexion Jellyfin (`/api/auth/jellyfin`), le
 * compte administrateur local (`adminSessionResponse`) et le passage d'une adresse à l'autre
 * (`/api/passage/redeem`, DECISIONS.md §119). Une session ouverte par le passage doit être
 * exactement celle d'une connexion — mêmes attributs, même durée —, d'où une seule écriture.
 */
export function setSignedInCookies(res: NextResponse, token: string, lang: string): void {
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
}

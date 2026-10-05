import { NextRequest, NextResponse } from "next/server";
import { saveSettings, setupDone } from "@/lib/settings/setup";
import { checkRateLimit } from "@/lib/rateLimiter";
import { getClientIp } from "@/lib/api-helpers";
import { LOCALES, type Locale } from "@/lib/i18n";

/**
 * La langue choisie au tout premier écran de l'assistant (DECISIONS.md §48).
 *
 * Publique — personne n'a encore de compte — et fermée une fois l'assistant terminé. Elle règle la
 * langue *de l'installation* (APP_LANGUAGE) et non celle du seul navigateur : avant toute connexion,
 * l'interface revient à la langue de l'installation, si bien qu'un choix gardé dans un cookie seul
 * aurait été défait au rechargement suivant.
 */
export async function POST(req: NextRequest) {
  if (!checkRateLimit(getClientIp(req))) return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  if (setupDone()) return NextResponse.json({ error: "setup-done" }, { status: 409 });
  const body = (await req.json().catch(() => null)) as { lang?: unknown } | null;
  const lang = body?.lang;
  if (typeof lang !== "string" || !LOCALES.includes(lang as Locale)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { errors } = saveSettings({ APP_LANGUAGE: lang });
  if (Object.keys(errors).length > 0) return NextResponse.json({ error: "invalid" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

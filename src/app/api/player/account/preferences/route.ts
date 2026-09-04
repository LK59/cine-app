import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { withErrorHandling } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export interface PlayerPreferences {
  audioLanguage: string | null;
  subtitleLanguage: string | null;
  /** Jellyfin : "Default" | "Always" | "OnlyForced" | "None" | "Smart". */
  subtitleMode: string | null;
}

function requireJellyfin(session: { jfId?: string; jfToken?: string } | null) {
  if (!session?.jfId || !session.jfToken) return null;
  return { userId: session.jfId, token: session.jfToken };
}

export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  const creds = requireJellyfin(session);
  if (!creds) return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });

  return withErrorHandling(async () => {
    const user = await jellyfin.getUserConfiguration(creds.userId, creds.token);
    return {
      audioLanguage: user.Configuration?.AudioLanguagePreference ?? null,
      subtitleLanguage: user.Configuration?.SubtitleLanguagePreference ?? null,
      subtitleMode: user.Configuration?.SubtitleMode ?? null,
    } satisfies PlayerPreferences;
  }, "player-preferences");
}

/**
 * Jellyfin remplace la configuration entière à chaque écriture : on relit donc la version
 * courante et on ne modifie que les champs demandés. Sans ça, changer la langue des sous-titres
 * effacerait au passage tout le reste des réglages du compte.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  const creds = requireJellyfin(session);
  if (!creds) return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as Partial<PlayerPreferences> | null;
  if (!body) return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });

  return withErrorHandling(async () => {
    const user = await jellyfin.getUserConfiguration(creds.userId, creds.token);
    const current = (user.Configuration ?? {}) as Record<string, unknown>;
    const next = { ...current };
    if ("audioLanguage" in body) next.AudioLanguagePreference = body.audioLanguage || null;
    if ("subtitleLanguage" in body) next.SubtitleLanguagePreference = body.subtitleLanguage || null;
    if ("subtitleMode" in body && body.subtitleMode) next.SubtitleMode = body.subtitleMode;

    await jellyfin.updateUserConfiguration(creds.userId, creds.token, next);
    return { ok: true };
  }, "player-preferences-save");
}

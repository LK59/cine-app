import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE, type Role } from "@/lib/auth";
import { sessionDb, userPrefsDb } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimiter";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { getClientIp } from "@/lib/api-helpers";
import { jellyseerr } from "@/lib/clients/jellyseerr";

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

  let jellyfinRes: Response;
  try {
    jellyfinRes = await fetch(`${config.jellyfin.url}/Users/AuthenticateByName`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          'MediaBrowser Client="CineApp", Device="Server", DeviceId="cine-app-server", Version="1.0.0"',
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
  } catch {
    return NextResponse.json({ error: "Impossible de contacter Jellyfin" }, { status: 502 });
  }

  if (!jellyfinRes.ok) {
    return NextResponse.json({ error: "Identifiants Jellyfin invalides" }, { status: 401 });
  }

  const data = await jellyfinRes.json();
  const isAdmin = data.User?.Policy?.IsAdministrator === true;
  const jellyfinUsername: string = data.User?.Name ?? username;
  const jellyfinId: string = data.User?.Id ?? "";
  const jellyfinToken: string = data.AccessToken ?? "";
  const role: Role = isAdmin ? "admin" : "guest";

  // Logs into Jellyseerr AS this same user, with the same credentials they just used here — the
  // only correct way to attribute a later request (e.g. from the "Demander" buttons) to them
  // specifically, since Jellyseerr auto-links an account to this exact Jellyfin identity the
  // first time it sees it (same mechanism as logging into Jellyseerr's own web UI). Best-effort:
  // a Jellyseerr outage or misconfiguration must not block signing into cine-app itself, whose
  // own auth is against Jellyfin, not Jellyseerr.
  const jellyseerrCookie = config.jellyseerr.apiKey
    ? await jellyseerr.login(username, password).catch(() => null)
    : null;

  const { token, jti } = await createSessionToken(
    jellyfinUsername,
    role,
    jellyfinUsername,
    jellyfinId,
    jellyfinToken,
    jellyseerrCookie ?? undefined
  );
  const userId = jellyfinId || jellyfinUsername;
  sessionDb.create(jti, userId);
  const lang = userPrefsDb.getLang(userId, config.app.language);
  const res = NextResponse.json({ ok: true, role });
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

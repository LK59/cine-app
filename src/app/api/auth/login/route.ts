import { revokeJellyfinDevices } from "@/lib/jellyfinRevoke";
import { NextRequest, NextResponse } from "next/server";
import { deviceLabel } from "@/lib/deviceLabel";
import { config } from "@/lib/config";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";
import { sessionDb, userPrefsDb } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimiter";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { getClientIp } from "@/lib/api-helpers";
import { timingSafeEquals } from "@/lib/timingSafeEquals";
import { passwordAttempts, hasLeadingSpace } from "@/lib/passwordAttempts";
import { logAuthEvent } from "@/lib/eventLogs";

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

  // La forme donnée d'abord, la forme sans espace finale ensuite — voir `passwordAttempts`. Les
  // deux passent par `timingSafeEquals` : une comparaison qui s'arrête au premier caractère
  // différent laisse deviner le mot de passe, et ce n'est pas parce qu'il y en a deux qu'on peut
  // se le permettre une fois.
  const isAdmin =
    username === config.app.adminUser &&
    !!config.app.adminPassword &&
    passwordAttempts(password).some((candidate) => timingSafeEquals(candidate, config.app.adminPassword));

  if (!isAdmin) {
    logAuthEvent("login-failed", { user: username, ip, device: deviceLabel(req.headers.get("user-agent")), reason: "compte local refusé" });
    return NextResponse.json(
      { error: "Identifiants invalides", ...(hasLeadingSpace(password) ? { code: "password-leading-space" } : {}) },
      { status: 401 }
    );
  }

  const { token, jti } = await createSessionToken(username, "admin");
  const expired = sessionDb.create(jti, username, deviceLabel(req.headers.get("user-agent")));
  // Les sessions expirées effacées au passage : leurs jetons Jellyfin ne serviront plus.
  void revokeJellyfinDevices(expired, "session expirée");
  logAuthEvent("login", { user: username, ip, device: deviceLabel(req.headers.get("user-agent")), role: "admin", local: true });
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

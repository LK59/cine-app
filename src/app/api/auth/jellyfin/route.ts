import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE, type Role } from "@/lib/auth";
import { sessionDb } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimiter";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
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

  const { token, jti } = await createSessionToken(jellyfinUsername, role, jellyfinUsername, jellyfinId, jellyfinToken);
  const userId = jellyfinId || jellyfinUsername;
  sessionDb.create(jti, userId);
  const res = NextResponse.json({ ok: true, role });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.app.cookieSecure,
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}

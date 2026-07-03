import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";

// In-memory rate limiter: max 10 attempts per IP per 15 minutes
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;

// Purge expired entries every 15 min so the Map doesn't grow indefinitely
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (now > entry.resetAt) attempts.delete(ip);
  }
}, WINDOW_MS).unref?.();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

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

  const isAdmin =
    username === config.app.adminUser &&
    config.app.adminPassword &&
    password === config.app.adminPassword;

  if (!isAdmin) {
    return NextResponse.json({ error: "Identifiants invalides" }, { status: 401 });
  }

  const token = await createSessionToken(username, "admin");
  const res = NextResponse.json({ ok: true, role: "admin" });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.app.cookieSecure,
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return res;
}

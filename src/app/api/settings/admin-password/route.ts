import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { sessionDb } from "@/lib/db";
import { createSetupAdmin, localAdmin, MIN_ADMIN_PASSWORD, verifySetupAdmin } from "@/lib/settings/setup";
import { checkRateLimit } from "@/lib/rateLimiter";
import { getClientIp } from "@/lib/api-helpers";
import { logAuthEvent } from "@/lib/eventLogs";

/**
 * Changer le mot de passe du compte administrateur créé par l'assistant (DECISIONS.md §48).
 *
 * L'ancien mot de passe est demandé — une session laissée ouverte ne suffit pas à s'emparer du
 * compte —, et les autres sessions de ce compte sont fermées : changer de mot de passe parce qu'on
 * le croit connu d'un autre n'aurait sinon aucun effet sur lui. Un compte fixé par le .env
 * (`APP_ADMIN_PASSWORD`) se change dans le .env : refusé ici, et dit tel quel.
 */
export async function GET() {
  const admin = localAdmin();
  return NextResponse.json({ user: admin?.user ?? null, source: admin?.source ?? null });
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  const admin = localAdmin();
  if (!session || session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (admin?.source !== "setup") return NextResponse.json({ error: "env-managed" }, { status: 409 });

  const body = (await req.json().catch(() => null)) as { current?: unknown; next?: unknown } | null;
  const current = typeof body?.current === "string" ? body.current : "";
  const next = typeof body?.next === "string" ? body.next : "";
  if (!verifySetupAdmin(admin.user, current)) return NextResponse.json({ error: "wrong-password" }, { status: 400 });
  if (next.length < MIN_ADMIN_PASSWORD || next.length > 256) return NextResponse.json({ error: "weak-password" }, { status: 400 });

  createSetupAdmin(admin.user, next);
  const closed = sessionDb.listOthers(admin.user, session.jti);
  for (const other of closed) sessionDb.delete(other.jti);
  logAuthEvent("password-changed", { user: admin.user, ip, closedSessions: closed.length });
  return NextResponse.json({ ok: true, closedSessions: closed.length });
}

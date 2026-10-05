import { NextRequest, NextResponse } from "next/server";
import { createSetupAdmin, localAdmin, MIN_ADMIN_PASSWORD, setupDone } from "@/lib/settings/setup";
import { adminSessionResponse } from "@/lib/adminSession";
import { checkRateLimit } from "@/lib/rateLimiter";
import { getClientIp } from "@/lib/api-helpers";

const USERNAME = /^[\p{L}\p{N}._@-]{1,64}$/u;

/**
 * Crée le compte administrateur, à l'assistant de premier lancement (DECISIONS.md §48).
 *
 * Publique — personne n'a encore de compte —, et pour cette raison fermée dès qu'elle a servi :
 * refusée une fois l'assistant terminé, ou dès qu'un compte administrateur existe (celui de `.env`
 * ou un créé ici). Elle ouvre aussitôt la session du compte créé, pour enchaîner sur la suite de
 * l'assistant.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  if (setupDone() || localAdmin() !== null) return NextResponse.json({ error: "admin-exists" }, { status: 409 });

  const body = (await req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!USERNAME.test(username)) return NextResponse.json({ error: "invalid-username" }, { status: 400 });
  if (password.length < MIN_ADMIN_PASSWORD || password.length > 256) return NextResponse.json({ error: "weak-password" }, { status: 400 });

  createSetupAdmin(username, password);
  return adminSessionResponse(req, username, ip);
}

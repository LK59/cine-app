import { NextRequest, NextResponse } from "next/server";
import { createSetupAdmin, localAdmin, MIN_ADMIN_PASSWORD, setupDone } from "@/lib/settings/setup";
import { adminSessionResponse } from "@/lib/adminSession";
import { checkRateLimit } from "@/lib/rateLimiter";
import { getClientIp } from "@/lib/api-helpers";
import { clearSetupCode, ensureSetupCode, setupCodeLogLine, verifySetupCode } from "@/lib/settings/setupCode";

const USERNAME = /^[\p{L}\p{N}._@-]{1,64}$/u;

/**
 * Crée le compte administrateur, à l'assistant de premier lancement (DECISIONS.md §48).
 *
 * Publique — personne n'a encore de compte —, et pour cette raison fermée dès qu'elle a servi :
 * refusée une fois l'assistant terminé, ou dès qu'un compte administrateur existe (celui de `.env`
 * ou un créé ici). Elle ouvre aussitôt la session du compte créé, pour enchaîner sur la suite de
 * l'assistant.
 *
 * Et seulement avec le code d'installation (20/10/2026) : tiré au démarrage, lisible dans les seuls
 * journaux du conteneur (`setupCode.ts`). Sans lui, la première personne à joindre le port d'une
 * installation neuve en devenait l'administrateur.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  if (setupDone() || localAdmin() !== null) return NextResponse.json({ error: "admin-exists" }, { status: 409 });

  // Le code manque (fichier effacé à la main, démarrage qui n'a pas pu l'écrire) : tiré ici, et dit
  // aux journaux comme au démarrage. Un disque illisible refuse plutôt que d'ouvrir sans code.
  let current: ReturnType<typeof ensureSetupCode>;
  try {
    current = ensureSetupCode();
  } catch {
    return NextResponse.json({ error: "setup-code-unavailable" }, { status: 503 });
  }
  if (current?.created) console.log(setupCodeLogLine(current.code));

  const body = (await req.json().catch(() => null)) as { username?: unknown; password?: unknown; setupCode?: unknown } | null;
  if (!current || !verifySetupCode(body?.setupCode)) return NextResponse.json({ error: "invalid-setup-code" }, { status: 403 });
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!USERNAME.test(username)) return NextResponse.json({ error: "invalid-username" }, { status: 400 });
  if (password.length < MIN_ADMIN_PASSWORD || password.length > 256) return NextResponse.json({ error: "weak-password" }, { status: 400 });

  createSetupAdmin(username, password);
  clearSetupCode();
  return adminSessionResponse(req, username, ip);
}

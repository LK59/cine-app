import { NextRequest, NextResponse } from "next/server";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { config } from "@/lib/config";
import { checkRateLimit } from "@/lib/rateLimiter";
import { getClientIp } from "@/lib/api-helpers";
import { timingSafeEquals } from "@/lib/timingSafeEquals";
import { passwordAttempts, hasLeadingSpace, readCredentials } from "@/lib/passwordAttempts";
import { logAuthEvent } from "@/lib/eventLogs";
import { adminSessionResponse } from "@/lib/adminSession";
import { verifySetupAdmin } from "@/lib/settings/setup";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: "Trop de tentatives, réessayez dans 15 minutes" }, { status: 429 });
  }

  // Types et longueurs vérifiés avant tout travail : ce qui suit compare, journalise et appelle
  // Jellyfin avec ces valeurs, et la route est publique — voir `readCredentials`.
  const credentials = readCredentials(await req.json().catch(() => null));
  if (!credentials) {
    return NextResponse.json({ error: "Identifiants requis" }, { status: 400 });
  }
  const { username, password } = credentials;

  // La forme donnée d'abord, la forme sans espace finale ensuite — voir `passwordAttempts`. Les
  // deux passent par `timingSafeEquals` : une comparaison qui s'arrête au premier caractère
  // différent laisse deviner le mot de passe, et ce n'est pas parce qu'il y en a deux qu'on peut
  // se le permettre une fois.
  // Le compte de `.env`, ou celui créé par l'assistant de premier lancement (DECISIONS.md §48) —
  // gardé haché, vérifié par `verifySetupAdmin`.
  const isAdmin =
    (username === config.app.adminUser &&
      !!config.app.adminPassword &&
      passwordAttempts(password).some((candidate) => timingSafeEquals(candidate, config.app.adminPassword))) ||
    (!config.app.adminPassword && passwordAttempts(password).some((candidate) => verifySetupAdmin(username, candidate)));

  if (!isAdmin) {
    logAuthEvent("login-failed", { user: username, ip, device: requestDeviceLabel(req), reason: "compte local refusé" });
    return NextResponse.json(
      { error: "Identifiants invalides", ...(hasLeadingSpace(password) ? { code: "password-leading-space" } : {}) },
      { status: 401 }
    );
  }

  return adminSessionResponse(req, username, ip);
}

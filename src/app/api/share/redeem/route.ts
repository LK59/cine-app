import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { sessionDb } from "@/lib/db";
import { forgetBeat } from "@/lib/activity/presence";
import { revokeJellyfinDevices } from "@/lib/jellyfinRevoke";
import { config } from "@/lib/config";
import { getClientIp } from "@/lib/api-helpers";
import { forwardedFor } from "@/lib/clientAddress";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { createRateLimiter } from "@/lib/rateLimiter";
import { logError } from "@/lib/logger";
import { isShareCode } from "@/lib/share/store";
import { redeemShare } from "@/lib/share/service";

/**
 * L'entrée d'un lien de partage (DECISIONS.md §112) : `{ code, password }` contre une session
 * `share`. Publique (`publicPaths.ts`), donc freinée deux fois : par adresse, comme la connexion,
 * et par lien — un lien qui circule ne s'essaie pas depuis cent adresses. Un refus ne dit jamais
 * pourquoi.
 */
const perAddress = createRateLimiter(10, 15 * 60_000);
const perCode = createRateLimiter(20, 60 * 60_000);

const MAX_PASSWORD = 64;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const body = (await req.json().catch(() => null)) as { code?: unknown; password?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!isShareCode(code) || !password || password.length > MAX_PASSWORD) {
    return NextResponse.json({ error: "Code ou mot de passe incorrect", code: "share-refused" }, { status: 400 });
  }
  if (!perAddress(ip) || !perCode(code)) {
    return NextResponse.json({ error: "Trop d'essais, réessayez plus tard", code: "rate_limited" }, { status: 429 });
  }
  try {
    const result = await redeemShare(code, password, { ip, device: requestDeviceLabel(req), forwarded: await forwardedFor() });
    if (!result) return NextResponse.json({ error: "Code ou mot de passe incorrect", code: "share-refused" }, { status: 401 });
    // La session que ce navigateur avait — un compte du foyer, un autre lien — est fermée, pas
    // seulement remplacée dans le cookie : comme une déconnexion, son jeton Jellyfin est retiré.
    const previous = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
    if (previous?.jti) {
      forgetBeat(previous.jti);
      void revokeJellyfinDevices([sessionDb.delete(previous.jti)], "remplacée par un lien de partage");
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.app.cookieSecure,
      maxAge: Math.max(1, Math.floor((result.share.expiresAt - Date.now()) / 1000)),
      path: "/",
    });
    return res;
  } catch (err) {
    logError("share.redeem", err);
    return NextResponse.json({ error: "Le serveur média ne répond pas", code: "share-unavailable" }, { status: 502 });
  }
}

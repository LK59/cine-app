import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { sessionDb, userPrefsDb } from "@/lib/db";
import { config } from "@/lib/config";
import { crossSiteWrite } from "@/lib/crossSite";
import { getClientIp } from "@/lib/api-helpers";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logAuthEvent } from "@/lib/eventLogs";
import { forgetBeat } from "@/lib/activity/presence";
import { revokeJellyfinDevices } from "@/lib/jellyfinRevoke";
import { setSignedInCookies } from "@/lib/sessionCookies";
import { isPassageToken, normalizePassageCode, redeemPassage, type PassageKind } from "@/lib/passage/service";
import { notePassageFailure, passageBlocked, passageTiming } from "@/lib/passage/attempts";

/**
 * L'entrée du passage, côté nouvelle adresse (DECISIONS.md §119) : `{ token }` (le fragment de
 * `/passage`) ou `{ code }` (recopié), contre une session — ouverte **comme une connexion** : mêmes
 * cookies, mêmes attributs (`setSignedInCookies`), même ligne de session, l'appareil et l'adresse lus
 * de la requête. Publique (`publicPaths.ts`) : on n'a pas encore de session ici.
 *
 * Un refus est le même pour tout — secret inconnu, mal formé, expiré, déjà servi, session d'origine
 * fermée — et prend au moins `passageTiming.floorMs` (400 ms) : ni le corps ni le temps ne disent lequel. Les essais
 * ratés sont freinés (`attempts.ts`) ; le blocage, lui, se dit (429), pour qu'on sache attendre.
 */

const REFUSED = { error: "Ce passage n'est plus valable", code: "passage-refused" } as const;

async function settle(started: number): Promise<void> {
  const wait = passageTiming.floorMs - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  if (crossSiteWrite(req)) return NextResponse.json({ error: "Requête refusée" }, { status: 403 });
  const ip = getClientIp(req);
  const device = requestDeviceLabel(req);
  const body = (await req.json().catch(() => null)) as { token?: unknown; code?: unknown } | null;
  const kind: PassageKind = body && typeof body === "object" && "code" in body ? "code" : "token";

  if (passageBlocked(ip, kind)) {
    logAuthEvent("passage-blocked", { user: "?", ip, device, kind });
    await settle(started);
    return NextResponse.json({ error: "Trop d'essais, réessayez dans un quart d'heure", code: "rate_limited" }, { status: 429 });
  }

  const rawToken = body?.token;
  const secret = kind === "code" ? normalizePassageCode(body?.code) : isPassageToken(rawToken) ? rawToken : null;
  const redeemed = secret ? await redeemPassage(kind, secret, device).catch(() => null) : null;
  if (!redeemed) {
    notePassageFailure(ip, kind);
    logAuthEvent("passage-refused", { user: "?", ip, device, kind });
    await settle(started);
    return NextResponse.json(REFUSED, { status: 401 });
  }

  void revokeJellyfinDevices(redeemed.expiredDevices, "session expirée");
  // La session que ce navigateur avait sur cette adresse — un autre compte, un lien de partage — est
  // fermée comme par une déconnexion, pas seulement recouverte dans le cookie.
  const previous = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
  if (previous?.jti && previous.jti !== redeemed.jti) {
    forgetBeat(previous.jti);
    void revokeJellyfinDevices([sessionDb.delete(previous.jti)], "remplacée par un passage");
  }
  logAuthEvent("passage-received", { user: redeemed.user, ip, device, role: redeemed.role, kind });
  const lang = userPrefsDb.getLang(redeemed.userId, config.app.language);
  await settle(started);
  const res = NextResponse.json({ ok: true, role: redeemed.role });
  setSignedInCookies(res, redeemed.token, lang);
  return res;
}

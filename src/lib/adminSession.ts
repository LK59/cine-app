import { NextRequest, NextResponse } from "next/server";
import { revokeJellyfinDevices } from "@/lib/jellyfinRevoke";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { config } from "@/lib/config";
import { createSessionToken } from "@/lib/auth";
import { sessionDb, userPrefsDb } from "@/lib/db";
import { logAuthEvent } from "@/lib/eventLogs";
import { setSignedInCookies } from "@/lib/sessionCookies";

/**
 * Ouvre une session administrateur locale et la pose dans la réponse — la seule écriture de ces
 * étapes : la connexion (`/api/auth/login`) et la création du compte par l'assistant de premier
 * lancement (`/api/setup/admin`) ouvrent la même session, avec les mêmes cookies.
 */
export async function adminSessionResponse(req: NextRequest, username: string, ip: string): Promise<NextResponse> {
  const { token, jti } = await createSessionToken(username, "admin");
  const expired = sessionDb.create(jti, username, requestDeviceLabel(req));
  // Les sessions expirées effacées au passage : leurs jetons Jellyfin ne serviront plus.
  void revokeJellyfinDevices(expired, "session expirée");
  logAuthEvent("login", { user: username, ip, device: requestDeviceLabel(req), role: "admin", local: true });
  const lang = userPrefsDb.getLang(username, config.app.language);
  const res = NextResponse.json({ ok: true, role: "admin" });
  setSignedInCookies(res, token, lang);
  return res;
}

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { crossSiteWrite } from "@/lib/crossSite";
import { createRateLimiter } from "@/lib/rateLimiter";
import { getClientIp } from "@/lib/api-helpers";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logAuthEvent } from "@/lib/eventLogs";
import { createPassage } from "@/lib/passage/service";
import { passageTarget } from "@/lib/passage/target";

/**
 * Le passage vers la nouvelle adresse, côté ancienne (DECISIONS.md §119).
 *
 * `GET` : l'adresse de destination, ou `null` quand l'installation n'en annonce pas — le bandeau et
 * le lien des Nouveautés n'existent qu'avec elle. Jamais rien d'autre que le réglage du déploiement.
 *
 * `POST` : un jeton (deux minutes) et un code (quinze minutes) pour la session qui le demande, et
 * l'adresse complète à ouvrir — construite ici, depuis le réglage, avec le jeton dans le fragment.
 * Le client ne fournit jamais d'adresse. Foyer seulement (`admin`, `user`), même origine, dix
 * demandes par heure et par compte.
 */
const perAccount = createRateLimiter(10, 60 * 60_000);

async function household(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
  return session && (session.role === "admin" || session.role === "user") ? session : null;
}

export async function GET(req: NextRequest) {
  const session = await household(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const target = passageTarget(config.news?.laternaAddress);
  return NextResponse.json({ target: target?.origin ?? null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  // Le proxy le refuse déjà ; posé ici aussi parce que cette écriture fabrique une session.
  if (crossSiteWrite(req)) return NextResponse.json({ error: "Requête refusée" }, { status: 403 });
  const session = await household(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const target = passageTarget(config.news?.laternaAddress);
  if (!target) return NextResponse.json({ error: "Pas de nouvelle adresse", code: "passage-unavailable" }, { status: 404 });
  if (!perAccount(session.u)) {
    return NextResponse.json({ error: "Trop de demandes, réessayez plus tard", code: "rate_limited" }, { status: 429 });
  }
  const body = (await req.json().catch(() => null)) as { settings?: unknown; pushEndpoint?: unknown; downloads?: unknown } | null;
  // `downloads` : la liste des téléchargements de ce compte sur cet appareil — jamais les fichiers.
  const result = await createPassage(session, { settings: body?.settings, pushEndpoint: body?.pushEndpoint, downloads: body?.downloads });
  if (!result.ok) {
    return NextResponse.json(
      result.reason === "relogin"
        ? { error: "Reconnectez-vous une fois sur cette adresse, puis réessayez", code: "passage-relogin" }
        : { error: "Action refusée", code: "passage-forbidden" },
      { status: result.reason === "relogin" ? 409 : 403 }
    );
  }
  logAuthEvent("passage-requested", { user: session.jfUser ?? session.u, ip: getClientIp(req), device: requestDeviceLabel(req), to: target.host });
  return NextResponse.json(
    {
      url: `${target.origin}/passage#t=${result.token}`,
      target: target.origin,
      code: result.code,
      codeExpiresAt: result.codeExpiresAt,
      tokenExpiresAt: result.tokenExpiresAt,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

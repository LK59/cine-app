import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { config } from "@/lib/config";
import { decide, requestHideView, setAuto, syncRequestHide } from "@/lib/requestHide/run";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Le masquage des demandes pour un compte (`requestHide/`) — administrateur seul, lecture comprise
 * (`proxy.ts` la range aussi dans `ADMIN_ONLY_READS`) : elle nomme qui a demandé quoi. Fonction coupée
 * (aucun compte nommé) : 404, comme si elle n'existait pas — sauf `?state=1`, qui répond `{ enabled: false }`.
 *
 * GET : chaque titre de la bibliothèque et son état ; `?state=1` dit seulement si la fonction est là
 * (le lien de la page Jellyseerr). POST : `{ keys, state: "hidden" | "shown" }` ou `{ auto: boolean }`,
 * puis un passage part en arrière-plan pour recopier la liste dans Jellyfin.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  // `?state=1` répond toujours 200 : c'est la question « la fonction est-elle là ? », posée à chaque
  // ouverture de la page Jellyseerr, et « non » n'est pas une erreur. Un 404 y laissait une erreur en
  // console sur toute installation sans masquage (vu le 18/11/2026). Le reste de la route garde son 404.
  if (req.nextUrl.searchParams.get("state") === "1") {
    return NextResponse.json(config.requestHide.enabled ? { enabled: true, account: config.requestHide.account } : { enabled: false });
  }
  if (!config.requestHide.enabled) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  try {
    return NextResponse.json(await requestHideView());
  } catch (err) {
    logError("request-hide.view", err);
    return NextResponse.json({ error: "Jellyfin ou Jellyseerr ne répond pas" }, { status: 502 });
  }
}

const KEY = /^(movie|series|series-tvdb):\d{1,12}$/;

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  if (!config.requestHide.enabled) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { keys?: unknown; state?: unknown; titles?: unknown; auto?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
  if (typeof body.auto === "boolean") {
    setAuto(body.auto);
  } else {
    const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string" && KEY.test(k)) : [];
    if (keys.length === 0 || keys.length > 5000 || (body.state !== "hidden" && body.state !== "shown")) {
      return NextResponse.json({ error: "Demande invalide" }, { status: 400 });
    }
    const titles = new Map<string, string>();
    if (body.titles && typeof body.titles === "object") {
      for (const [k, v] of Object.entries(body.titles as Record<string, unknown>)) if (typeof v === "string" && KEY.test(k)) titles.set(k, v.slice(0, 300));
    }
    decide(keys, body.state, titles);
  }
  void syncRequestHide();
  return NextResponse.json({ ok: true }, { status: 202 });
}

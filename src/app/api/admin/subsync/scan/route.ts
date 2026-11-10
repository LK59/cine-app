import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { xrayConfigured } from "@/lib/clients/xray";
import { logError } from "@/lib/logger";
import { launchScan } from "@/lib/subtitleSync/admin";
import { parseScanScope } from "@/lib/subtitleSync/scope";

export const dynamic = "force-dynamic";

/**
 * « Scanner » (DECISIONS.md §141) : `{ scope: "item" | "season" | "series" | "movies", … }` — la mesure des
 * sous-titres de chaque élément part au service, à basse priorité. Le seul chemin qui en commande une : rien ne
 * se mesure sans ce clic. Administrateur seul (`adminOnly`, et l'écriture n'est pas dans la liste blanche des
 * comptes). Le service coupé ou pas réglé : 409, jamais 404.
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const scope = parseScanScope(await req.json().catch(() => null));
  if (!scope) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (!xrayConfigured()) return NextResponse.json({ error: "off" }, { status: 409 });
  try {
    return NextResponse.json(await launchScan(scope, session.u), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logError("subtitle-sync/scan", error, { scope: scope.scope });
    return NextResponse.json({ error: "scan" }, { status: 502 });
  }
}

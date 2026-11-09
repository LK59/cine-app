import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { xray, xrayConfigured, type XrayPriority } from "@/lib/clients/xray";
import { orderAnalysis } from "@/lib/xray/orders";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };
const PRIORITIES: readonly XrayPriority[] = ["high", "normal", "low"];

/**
 * Les acteurs à l'écran, côté administrateur (DECISIONS.md §138) — pour les bancs : lire l'état du
 * service et d'un élément, et commander une analyse à la main. Administrateur seul, lecture comprise
 * (`adminOnly`, et `ADMIN_ONLY_READS` dans `proxy.ts`) ; l'écriture n'est pas dans la liste blanche
 * des comptes, donc refusée à tout autre d'office.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  if (!xrayConfigured()) return NextResponse.json({ configured: false }, { headers: PRIVATE });
  const itemId = req.nextUrl.searchParams.get("itemId");
  if (itemId !== null && !isJellyfinId(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  const [health, item] = await Promise.all([
    xray.health().catch((error: unknown) => ({ error: error instanceof Error ? error.message.slice(0, 200) : "injoignable" })),
    itemId ? xray.itemStatus(itemId.toLowerCase()).catch(() => null) : Promise.resolve(undefined),
  ]);
  return NextResponse.json({ configured: true, health, ...(item !== undefined ? { item } : {}) }, { headers: PRIVATE });
}

/** `{ itemId, priority?, startAt? }` : commande l'analyse, mémoire des commandes ignorée. */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { itemId?: unknown; priority?: unknown; startAt?: unknown } | null;
  if (!isJellyfinId(body?.itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  const priority = PRIORITIES.includes(body?.priority as XrayPriority) ? (body!.priority as XrayPriority) : "normal";
  const startAt = typeof body?.startAt === "number" && Number.isFinite(body.startAt) && body.startAt > 0 ? body.startAt : undefined;
  const outcome = await orderAnalysis(body.itemId, { priority, startAt, force: true });
  const status = outcome.status === "off" ? 409 : outcome.status === "failed" ? 502 : 200;
  return NextResponse.json(outcome, { status, headers: PRIVATE });
}

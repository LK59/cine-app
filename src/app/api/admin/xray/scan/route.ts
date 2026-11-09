import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";
import { SCAN_TIERS, type ScanTier } from "@/lib/xray/scanPlan";
import { prioritizeTitle, scanAction, unprioritizeTitle, xrayScanStatus, type ScanAction } from "@/lib/xray/scheduler";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };
const ACTIONS: readonly ScanAction[] = ["run", "pause", "resume", "unforce"];

/**
 * L'analyse de la bibliothèque en fond, vue de la Configuration (DECISIONS.md §138, « Le planificateur
 * de la bibliothèque ») : sa progression par palier (`GET`) et ses gestes (`POST`) —
 * `{ action: "run" | "pause" | "resume" | "unforce", tier? }` (« Lancer maintenant », pause, reprise,
 * fin du forçage ; sans palier : tous), et `{ action: "prioritize" | "unprioritize", itemId }` (la liste
 * de priorité : un film ou une série, par son identifiant Jellyfin — aussi depuis la fiche du cinéma).
 * Administrateur seul, lecture comprise : `adminOnly` ici, et `/api/admin/xray` est dans
 * `ADMIN_ONLY_READS` du proxy (les titres de toute la bibliothèque, tags bloqués compris) ; l'écriture
 * n'est pas dans la liste blanche des comptes.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  try {
    return NextResponse.json(xrayScanStatus(), { headers: PRIVATE });
  } catch (error) {
    logError("xray/scan-status", error);
    return NextResponse.json({ error: "status" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { action?: unknown; tier?: unknown; itemId?: unknown } | null;
  const action = body?.action;
  if (action === "prioritize" || action === "unprioritize") {
    if (!isJellyfinId(body?.itemId)) return NextResponse.json({ error: "invalid" }, { status: 400 });
    if (!xrayScanStatus().configured) return NextResponse.json({ error: "off" }, { status: 409 });
    if (action === "prioritize") {
      // Refusé avec sa raison : `animation` (la page le dit), `not-found` (pas un film ni une série de la bibliothèque).
      const refusal = await prioritizeTitle(body.itemId);
      // 409 dans les deux cas, jamais 404 (CLAUDE.md, « An expected absence is never a 404 »).
      if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
    } else {
      unprioritizeTitle(body.itemId);
    }
    return NextResponse.json(xrayScanStatus(), { headers: PRIVATE });
  }
  if (!ACTIONS.includes(action as ScanAction)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const tier = body?.tier === undefined || body?.tier === null ? null : (body.tier as ScanTier);
  if (tier !== null && !SCAN_TIERS.includes(tier)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (!xrayScanStatus().configured) return NextResponse.json({ error: "off" }, { status: 409 });
  await scanAction(action as ScanAction, tier);
  return NextResponse.json(xrayScanStatus(), { headers: PRIVATE });
}

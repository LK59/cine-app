import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { logError } from "@/lib/logger";
import { SCAN_TIERS, type ScanTier } from "@/lib/xray/scanPlan";
import { scanAction, xrayScanStatus, type ScanAction } from "@/lib/xray/scheduler";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };
const ACTIONS: readonly ScanAction[] = ["run", "pause", "resume", "unforce"];

/**
 * L'analyse de la bibliothèque en fond, vue de la Configuration (DECISIONS.md §138, « Le planificateur
 * de la bibliothèque ») : sa progression par palier (`GET`) et ses gestes (`POST { action, tier? }` —
 * `run` « Lancer maintenant », `pause`, `resume`, `unforce`). Administrateur seul, lecture comprise :
 * `adminOnly` ici, et `/api/admin/xray` est dans `ADMIN_ONLY_READS` du proxy (les titres de toute la
 * bibliothèque, tags bloqués compris) ; l'écriture n'est pas dans la liste blanche des comptes.
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
  const body = (await req.json().catch(() => null)) as { action?: unknown; tier?: unknown } | null;
  const action = body?.action as ScanAction;
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const tier = body?.tier === undefined || body?.tier === null ? null : (body.tier as ScanTier);
  if (tier !== null && !SCAN_TIERS.includes(tier)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const status = xrayScanStatus();
  if (!status.configured) return NextResponse.json({ error: "off" }, { status: 409 });
  await scanAction(action, tier);
  return NextResponse.json(xrayScanStatus(), { headers: PRIVATE });
}

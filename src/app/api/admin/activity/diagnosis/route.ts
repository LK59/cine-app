import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { clearDiagnosis } from "@/lib/activity/diagnosisCleared";
import { failingTitleKeys } from "@/lib/activity/accounts";

export const dynamic = "force-dynamic";

/**
 * Effacer des titres du diagnostic « le fichier ou l'appareil ? » — `{ keys: string[] }`, les clés
 * que la vue d'ensemble a reçues, ou `{ all: true }` pour tous ceux de la période, affichés ou non.
 * Ils reviennent s'ils échouent de nouveau (`diagnosisCleared.ts`).
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { keys?: unknown; all?: unknown } | null;
  const keys = body?.all === true ? failingTitleKeys() : Array.isArray(body?.keys) ? body.keys.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 200).slice(0, 100)
      : [];
  if (keys.length === 0) return NextResponse.json({ error: "Aucun titre" }, { status: 400 });
  clearDiagnosis(keys);
  return NextResponse.json({ ok: true, cleared: keys.length });
}

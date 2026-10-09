import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { alertsClearedAt, setAlertsClearedAt } from "@/lib/activity/alertsCleared";

export const dynamic = "force-dynamic";

/**
 * Effacer les alertes du panneau Activités, ou les réafficher (09/10/2026, DECISIONS.md §59).
 *
 * `clear` pose la date d'effacement à maintenant ; `restore` la remet à zéro — rien n'est perdu,
 * puisque les journaux ne sont jamais touchés (`alertsCleared.ts`).
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action === "clear") setAlertsClearedAt(Date.now());
  else if (body?.action === "restore") setAlertsClearedAt(0);
  else return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  return NextResponse.json({ ok: true, clearedAt: alertsClearedAt() });
}

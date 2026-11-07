import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { alertsClearedAt, dismissIssue, setAlertsClearedAt } from "@/lib/activity/alertsCleared";

export const dynamic = "force-dynamic";

/**
 * Effacer les alertes du panneau Activités, ou les réafficher (09/10/2026, DECISIONS.md §59).
 *
 * `clear` pose la date d'effacement à maintenant : les incidents d'avant sortent de toutes les
 * statistiques, définitivement — « Réafficher » a été retiré le 07/11/2026 à la demande de Louis. Les
 * journaux, eux, ne sont jamais touchés (`alertsCleared.ts`) : le détail d'une séance reste lisible. `dismiss` efface une seule ligne
 * de « À gérer », par sa clé (07/11/2026).
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { action?: unknown; key?: unknown } | null;
  if (body?.action === "dismiss" && typeof body.key === "string" && body.key) dismissIssue(body.key);
  else if (body?.action === "clear") setAlertsClearedAt(Date.now());
  else return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  return NextResponse.json({ ok: true, clearedAt: alertsClearedAt() });
}

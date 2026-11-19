import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { logError } from "@/lib/logger";
import { triPayload } from "@/lib/tri/collect";

export const dynamic = "force-dynamic";

/**
 * Le tri de la bibliothèque (DECISIONS.md §198) — administrateur seul, lecture comprise (`proxy.ts` le
 * range dans `ADMIN_ONLY_READS`) : il nomme chaque demande de chaque compte et ce que chacun a vu.
 * `?force=1` recalcule au lieu de servir la collecte des dix dernières minutes.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  try {
    return NextResponse.json(await triPayload(req.nextUrl.searchParams.get("force") === "1"));
  } catch (e) {
    logError("tri", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

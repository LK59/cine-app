import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { downloadsOverview } from "@/lib/activity/offlineDownloads";

export const dynamic = "force-dynamic";

/**
 * Les téléchargements vus de l'Activité — administrateur seul, lecture comprise (`proxy.ts` la
 * range aussi dans `ADMIN_ONLY_READS`) : la liste nomme chaque compte et ce qu'il a emporté, titres
 * cachés par un tag bloqué compris (§54).
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  return NextResponse.json(await downloadsOverview(), { headers: { "Cache-Control": "private, no-store" } });
}

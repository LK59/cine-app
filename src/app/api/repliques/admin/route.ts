import { NextRequest, NextResponse } from "next/server";
import { pauseIndexing, rebuildIndex, repliquesStatus, setIndexingForced, startIndexing } from "@/lib/repliques/engine";
import { logError } from "@/lib/logger";

/**
 * La recherche de répliques vue de la Configuration (DECISIONS.md §88) : l'état de l'indexation, et
 * ses gestes — lancer ou reprendre, mettre en pause, forcer (ne plus attendre la fin des lectures) ou
 * ne plus forcer, reconstruire. Lecture réservée à
 * l'administrateur (`ADMIN_ONLY_READS` du proxy) ; les écritures aussi (le proxy refuse toute
 * écriture d'un autre compte).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await repliquesStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logError("repliques.status", error);
    return NextResponse.json({ error: "status" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;
  let refusal: string | null = null;
  if (action === "start" || action === "resume") refusal = await startIndexing();
  else if (action === "pause") await pauseIndexing();
  else if (action === "force" || action === "unforce") refusal = setIndexingForced(action === "force");
  else if (action === "rebuild") refusal = await rebuildIndex();
  else return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
  return NextResponse.json(await repliquesStatus(), { headers: { "Cache-Control": "no-store" } });
}

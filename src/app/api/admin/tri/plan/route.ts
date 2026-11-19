import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { logError } from "@/lib/logger";
import { triPayload } from "@/lib/tri/collect";
import { planRemoval } from "@/lib/tri/plan";
import { parseTarget } from "@/lib/tri/target";

export const dynamic = "force-dynamic";

/**
 * L'aperçu d'une suppression (DECISIONS.md §198) : les fichiers, les torrents, l'espace attendu. Ne
 * touche à rien — c'est un POST seulement parce qu'il relit le disque et qBittorrent à la demande.
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const target = parseTarget(await req.json().catch(() => null));
  if (!target) return NextResponse.json({ error: "titre invalide" }, { status: 400 });
  try {
    const title = (await triPayload()).titles.find((t) => t.kind === target.kind && t.id === target.id);
    const plan = await planRemoval(target.kind, target.id, { jellyseerrMediaId: title?.jellyseerrMediaId ?? null, requests: title?.requests.length ?? 0 });
    return NextResponse.json(plan);
  } catch (e) {
    logError("tri", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

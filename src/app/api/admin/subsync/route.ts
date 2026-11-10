import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";
import { seriesView, treeView } from "@/lib/subtitleSync/admin";
import type { SyncFilter } from "@/lib/subtitleSync/types";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };
const FILTERS: readonly SyncFilter[] = ["affected", "measured", "all"];

/**
 * Configuration → Synchro des sous-titres (DECISIONS.md §141) : l'arbre (`?filter=affected|measured|all`) — films,
 * séries, saisons et leurs compteurs —, ou les épisodes d'une série (`&series=<id>`). Administrateur seul, lecture
 * comprise : `adminOnly` ici, et `/api/admin/subsync` est dans `ADMIN_ONLY_READS` du proxy (toute la bibliothèque,
 * tags bloqués compris). Une série inconnue se lit sans épisodes, jamais en 404 (CLAUDE.md, CrowdSec).
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const raw = req.nextUrl.searchParams.get("filter") ?? "affected";
  const filter = (FILTERS as readonly string[]).includes(raw) ? (raw as SyncFilter) : "affected";
  const series = req.nextUrl.searchParams.get("series");
  try {
    if (series !== null) {
      if (!isJellyfinId(series)) return NextResponse.json({ error: "invalid" }, { status: 400 });
      return NextResponse.json(await seriesView(series, filter), { headers: PRIVATE });
    }
    return NextResponse.json(await treeView(filter), { headers: PRIVATE });
  } catch (error) {
    logError("subtitle-sync/tree", error);
    return NextResponse.json({ error: "tree" }, { status: 500 });
  }
}

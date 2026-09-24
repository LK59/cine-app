import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { LOG_SOURCES, readRecords, typeOf, type LogSource } from "@/lib/activity/logReader";

export const dynamic = "force-dynamic";

const PAGE = 100;

/**
 * Un journal, de la ligne la plus récente vers la plus ancienne, filtré et par pages.
 *
 * `cursor` est le rang de la dernière ligne rendue : les journaux ne font que grandir par la fin,
 * donc une page déjà lue ne bouge pas pendant qu'on lit la suivante (sauf rotation, rare — la
 * page suivante repart alors du bon endroit à peu de lignes près).
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const q = req.nextUrl.searchParams;
  const source = (LOG_SOURCES as string[]).includes(q.get("source") ?? "") ? (q.get("source") as LogSource) : "player";
  const user = q.get("user")?.toLowerCase() || null;
  const type = q.get("type") || null;
  const search = q.get("q")?.toLowerCase() || null;
  const days = Number(q.get("days") ?? 0);
  const since = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  const session_ = q.get("session") || null;
  const records = readRecords(source);
  const cursor = Number(q.get("cursor"));
  let i = Number.isFinite(cursor) && cursor > 0 && cursor <= records.length ? cursor - 1 : records.length - 1;

  const items: Record<string, unknown>[] = [];
  for (; i >= 0 && items.length < PAGE; i--) {
    const r = records[i];
    if (since && r._t && r._t < since) break;
    if (user && String(r.user ?? "").toLowerCase() !== user) continue;
    if (type && typeOf(r) !== type) continue;
    if (session_ && r.session !== session_) continue;
    if (search && !JSON.stringify(r).toLowerCase().includes(search)) continue;
    items.push({ ...r, _index: i });
  }

  // De quoi remplir les listes de filtres : les comptes et les types présents dans ce journal.
  const users = new Set<string>();
  const types = new Map<string, number>();
  for (const r of records) {
    if (typeof r.user === "string" && r.user) users.add(r.user);
    const t = typeOf(r);
    types.set(t, (types.get(t) ?? 0) + 1);
  }

  return NextResponse.json({
    source,
    total: records.length,
    items,
    nextCursor: i >= 0 && items.length === PAGE ? i + 1 : null,
    facets: {
      users: [...users].sort((a, b) => a.localeCompare(b)),
      types: [...types].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { LOG_SOURCES, generationsNewestFirst, readGenerationRecords, typeOf, type LogSource } from "@/lib/activity/logReader";

export const dynamic = "force-dynamic";

const PAGE = 100;
/** Les listes de filtres (comptes, types) : lues sur les deux dernières générations, pas sur des années. */
const FACET_GENERATIONS = 2;

/**
 * Un journal, de la ligne la plus récente vers la plus ancienne, filtré et par pages.
 *
 * Les journaux gardent des centaines d'archives depuis le 24/09/2026 : on remonte génération par
 * génération, et on s'arrête dès que la page est pleine — une recherche qui trouve ses cent lignes
 * dans le fichier courant n'ouvre aucune archive. Une archive plus ancienne que la période n'est
 * même pas ouverte (sa date de dernière écriture suffit).
 *
 * `cursor` vaut `génération.ligne` — la génération comptée depuis la plus récente, la ligne dans
 * cette génération. Une rotation entre deux pages décale d'une génération ; c'est rare, et la
 * page suivante repart d'à peu près au bon endroit.
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
  const sessionId = q.get("session") || null;

  const generations = generationsNewestFirst(source);
  const [cg, ci] = (q.get("cursor") ?? "").split(".").map(Number);
  let g = Number.isInteger(cg) && cg >= 0 ? cg : 0;
  let resumeAt: number | null = Number.isInteger(ci) && ci >= 0 ? ci : null;

  const items: Record<string, unknown>[] = [];
  let next: string | null = null;
  let reachedEnd = false;
  scan: for (; g < generations.length; g++) {
    const { file, mtimeMs } = generations[g];
    // Toute l'archive est plus ancienne que la période : rien plus loin ne peut compter.
    if (since && g > 0 && mtimeMs < since) break;
    const records = readGenerationRecords(file);
    let i = resumeAt !== null ? Math.min(resumeAt, records.length) - 1 : records.length - 1;
    resumeAt = null;
    for (; i >= 0; i--) {
      if (items.length === PAGE) {
        next = `${g}.${i + 1}`;
        break scan;
      }
      const r = records[i];
      if (since && r._t && r._t < since) {
        reachedEnd = true;
        break scan;
      }
      if (user && String(r.user ?? "").toLowerCase() !== user) continue;
      if (type && typeOf(r) !== type) continue;
      if (sessionId && r.session !== sessionId) continue;
      if (search && !JSON.stringify(r).toLowerCase().includes(search)) continue;
      items.push(r);
    }
  }
  if (reachedEnd) next = null;

  const users = new Set<string>();
  const types = new Map<string, number>();
  let total = 0;
  for (const { file } of generations.slice(0, FACET_GENERATIONS)) {
    for (const r of readGenerationRecords(file)) {
      total += 1;
      if (typeof r.user === "string" && r.user) users.add(r.user);
      const t = typeOf(r);
      types.set(t, (types.get(t) ?? 0) + 1);
    }
  }

  return NextResponse.json({
    source,
    generations: generations.length,
    items,
    nextCursor: next,
    facets: {
      users: [...users].sort((a, b) => a.localeCompare(b)),
      types: [...types].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      recentLines: total,
    },
  });
}

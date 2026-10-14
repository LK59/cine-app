import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { LOG_SOURCES, generationsNewestFirst, lineUsers, matchesSearch, readGenerationRecords, typeOf, type LogSource } from "@/lib/activity/logReader";

export const dynamic = "force-dynamic";

const PAGE = 100;
/** Voir la boucle de lecture : au-delà, la page rend la main avec un curseur. */
const MAX_GENERATIONS_PER_PAGE = 8;
/**
 * Les listes de filtres (comptes, types) : comptées sur la **période choisie**, à travers au plus
 * ce nombre de générations. Elles l'étaient sur les deux derniers fichiers, quelle que soit la
 * période : « 1 dernier jour » affichait « seek (759) » pour quelques sauts du jour, et un type
 * vu le mois dernier dans une archive plus ancienne n'était pas proposé (relu le 14/10/2026).
 * La borne garde « Tout » d'ouvrir des centaines d'archives ; au-delà, `partial` le dit.
 */
const FACET_MAX_GENERATIONS = 8;

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
  const cursorParam = q.get("cursor");
  // Les filtres ne servent qu'à la première page ; le rafraîchissement automatique (toutes les
  // 20 s) les refuse aussi (`facets=0`) — il ne cherche que les lignes arrivées.
  const wantFacets = !cursorParam && q.get("facets") !== "0";

  const generations = generationsNewestFirst(source);
  const [cg, ci] = (cursorParam ?? "").split(".").map(Number);
  let g = Number.isInteger(cg) && cg >= 0 ? cg : 0;
  let resumeAt: number | null = Number.isInteger(ci) && ci >= 0 ? ci : null;

  const items: Record<string, unknown>[] = [];
  let next: string | null = null;
  let reachedEnd = false;
  // Une page parcourt au plus ce nombre de générations, pleine ou non, et rend la main avec un
  // curseur. Un filtre qui ne remplit jamais sa page — une séance de vingt lignes — relisait sinon
  // tout l'historique d'une traite, en bloquant le serveur (relu le 24/09/2026).
  let scanned = 0;
  scan: for (; g < generations.length; g++) {
    if (++scanned > MAX_GENERATIONS_PER_PAGE) {
      // Reprendre au début de cette génération-là : `Math.min` borne l'index à sa longueur.
      next = `${g}.${Number.MAX_SAFE_INTEGER}`;
      break;
    }
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
      if (user && !lineUsers(r).some((u) => u.toLowerCase() === user)) continue;
      if (type && typeOf(r) !== type) continue;
      if (sessionId && r.session !== sessionId) continue;
      if (search && !matchesSearch(r, search)) continue;
      items.push(r);
    }
  }
  if (reachedEnd) next = null;

  let facets: { users: string[]; types: { name: string; count: number }[]; recentLines: number; partial: boolean } | undefined;
  if (wantFacets) {
    const users = new Set<string>();
    const types = new Map<string, number>();
    let total = 0;
    let partial = false;
    for (let fg = 0; fg < generations.length; fg++) {
      const { file, mtimeMs } = generations[fg];
      // Comme la page : une archive entièrement plus ancienne que la période n'est pas ouverte.
      if (since && fg > 0 && mtimeMs < since) break;
      if (fg >= FACET_MAX_GENERATIONS) {
        partial = true;
        break;
      }
      for (const r of readGenerationRecords(file)) {
        if (since && r._t && r._t < since) continue;
        total += 1;
        for (const u of lineUsers(r)) users.add(u);
        const t = typeOf(r);
        types.set(t, (types.get(t) ?? 0) + 1);
      }
    }
    facets = {
      users: [...users].sort((a, b) => a.localeCompare(b)),
      types: [...types].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      recentLines: total,
      partial,
    };
  }

  return NextResponse.json({
    source,
    generations: generations.length,
    items,
    nextCursor: next,
    ...(facets && { facets }),
  });
}

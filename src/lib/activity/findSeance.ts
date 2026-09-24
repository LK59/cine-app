// Retrouver une séance de lecture, et toutes ses lignes, à partir de son identifiant.
//
// Les journaux gardent des années : on remonte génération par génération jusqu'à trouver la
// séance, et on s'arrête à la première génération qui n'en contient plus rien après l'avoir
// trouvée (une séance peut chevaucher une rotation, jamais deux). Une séance d'avant le 23/09/2026
// — sans identifiant — porte sa date dans le sien : on relit à partir de là.

import { generationsNewestFirst, readFullLines, readGenerationRecords, readRecords, type LogRecord } from "@/lib/activity/logReader";
import { buildSeances, type Seance } from "@/lib/activity/seances";

/**
 * Combien de générations on remonte au plus pour une séance qu'on ne trouve pas. Un identifiant ne
 * porte pas sa date ; sans borne, une séance sortie des journaux — un ticket ancien, un lien
 * périmé — faisait relire tout l'historique, jusqu'à un gigaoctet, en bloquant le serveur (relu le
 * 24/09/2026). Quarante générations de 5 Mo : des semaines de lecture, bien plus qu'on n'en relit.
 */
const MAX_SCANNED_GENERATIONS = 40;

export function findSeance(id: string): { seance: Seance; lines: Record<string, unknown>[] } | null {
  let records: LogRecord[] = [];
  if (id.startsWith("ancienne:")) {
    const start = Number(id.slice(id.lastIndexOf(":") + 1));
    records = Number.isFinite(start) ? readRecords("player", start - 60_000) : [];
  } else {
    const parts: LogRecord[][] = [];
    let found = false;
    let scanned = 0;
    for (const { file } of generationsNewestFirst("player")) {
      if (!found && ++scanned > MAX_SCANNED_GENERATIONS) break;
      const mine = readGenerationRecords(file).filter((r) => r.session === id);
      if (mine.length) {
        found = true;
        parts.push(mine);
      } else if (found) break;
    }
    records = parts.reverse().flat();
  }

  const seance = buildSeances(records).find((s) => s.id === id);
  if (!seance) return null;
  const mine = seance.legacy
    ? records.filter(
        (r) =>
          !r.session &&
          String(r.user ?? "") === seance.user &&
          (r.itemId ?? r.title) === (seance.itemId ?? seance.title) &&
          r._t >= seance.start &&
          r._t <= seance.end
      )
    : records;
  const lines = readFullLines("player", mine.map((r) => ({ file: r._file, line: r._line, at: r._t })));
  const stamp = (l: Record<string, unknown>) => Date.parse(String(l.timestamp ?? "")) || 0;
  lines.sort((a, b) => stamp(a) - stamp(b));
  return { seance, lines };
}

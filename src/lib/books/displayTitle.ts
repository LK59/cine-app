import type { BookSummary } from "@/lib/books/types";

/**
 * Le titre d'un livre tel que l'écran le montre (DECISIONS.md §127) : sans la série ni le tome quand
 * le nom les répète — « Cherub - Tome 3 - Arizona Max » devient « Arizona Max », puisque la ligne du
 * dessous dit déjà « Cherub · Tome 3 ». Beaucoup d'EPUB portent ce préfixe dans leur titre, sous des
 * formes diverses (« CHERUB 02 - Trafic », « Tome 13 - Le clan Aramov »).
 *
 * Une règle étroite, exprès : la série n'est retirée que suivie d'un séparateur (tiret, deux-points…)
 * ou de son propre numéro de tome — « Harry Potter et la Chambre des secrets » ne perd rien —, et un
 * numéro n'est retiré que s'il est celui du tome. Ce qui resterait vide rend le nom entier.
 */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "\\s*[-–—:·]\\s*";
const VOLUME = "(?:tome|t\\.?|vol(?:ume)?\\.?|mission|livre|book|band|n°|no\\.?|#)";

export function displayTitle(book: Pick<BookSummary, "name" | "seriesName" | "index">): string {
  const original = book.name.trim();
  let name = original;
  const number = book.index !== null && Number.isInteger(book.index) && book.index >= 0 ? `0*${book.index}` : null;
  if (book.seriesName) {
    const series = escape(book.seriesName.trim());
    // « Cherub - Cherub : Dossiers secrets » : la série deux fois.
    for (let i = 0; i < 2; i++) {
      const m = new RegExp(`^${series}${SEP}(.+)$`, "i").exec(name);
      if (!m) break;
      name = m[1];
    }
    if (number) {
      const m = new RegExp(`^${series}\\s+(?:${VOLUME}\\s*)?${number}${SEP}(.+)$`, "i").exec(name);
      if (m) name = m[1];
    }
  }
  if (number) {
    const m = new RegExp(`^(?:${VOLUME}\\s*)?${number}${SEP}(.+)$`, "i").exec(name);
    if (m) name = m[1];
  }
  name = name.trim();
  return name.length > 0 ? name : original;
}

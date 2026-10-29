import { getDb } from "@/lib/db";
import type { BookIndex } from "@/lib/books/bookIndex";
import type { BookSummary } from "@/lib/books/types";

/**
 * « Ma liste de lecture » (DECISIONS.md §129) — la table `book_list` : les livres qu'un compte se promet
 * de lire, rangés sous le compte de l'application (`session.u`) comme sa position. À part de la liste des
 * films et séries (`watchlist`), qui ne connaît que ceux-là et vit de leurs identifiants TMDB.
 *
 * Un livre terminé en sort de lui-même (`removeFromReadingList`, appelé par la route de la position à la
 * première fin) : la liste dit ce qui reste à lire. Bornée : au-delà, c'est un script, pas une liste.
 */
export const MAX_LISTED = 2000;

interface Row {
  item_id: string;
  added_at: number;
}

export function listedBooks(account: string): { itemId: string; addedAt: number }[] {
  const rows = getDb().prepare("SELECT item_id, added_at FROM book_list WHERE account = ? ORDER BY added_at DESC").all(account) as Row[];
  return rows.map((r) => ({ itemId: r.item_id, addedAt: r.added_at }));
}

/** Ajoute ; rend `false` si la liste est pleine. Un livre déjà là garde sa date. */
export function addToReadingList(account: string, itemId: string, now = Date.now()): boolean {
  const db = getDb();
  return db.transaction(() => {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM book_list WHERE account = ?").get(account) as { n: number }).n;
    const there = db.prepare("SELECT 1 FROM book_list WHERE account = ? AND item_id = ?").get(account, itemId);
    if (!there && count >= MAX_LISTED) return false;
    db.prepare("INSERT INTO book_list (account, item_id, added_at) VALUES (?, ?, ?) ON CONFLICT(account, item_id) DO NOTHING").run(account, itemId, now);
    return true;
  })();
}

/** Retire ; rend `true` si le livre y était. */
export function removeFromReadingList(account: string, itemId: string): boolean {
  return getDb().prepare("DELETE FROM book_list WHERE account = ? AND item_id = ?").run(account, itemId).changes > 0;
}

/**
 * La liste de ce compte telle que sa vue de l'index la permet : un livre retiré de la bibliothèque, ou que
 * ses droits ne laissent plus voir (un tag bloqué posé depuis), n'y paraît pas — sa ligne reste, et il
 * revient s'il redevient visible. Les plus récemment ajoutés d'abord ; `listedAt` est la date d'ajout à la
 * liste (`addedAt` est celle de la bibliothèque).
 */
export function readingListFrom(index: Pick<BookIndex, "all">, rows: { itemId: string; addedAt: number }[]): (BookSummary & { listedAt: number })[] {
  return rows.flatMap((r) => {
    const book = index.all.get(r.itemId);
    return book ? [{ ...book, listedAt: r.addedAt }] : [];
  });
}

import { getDb } from "@/lib/db";

/**
 * Les signets d'un compte dans un livre (DECISIONS.md §127) — la table `book_bookmarks`.
 *
 * Gardés par l'application, sous le compte de la session (`session.u`), comme la position : ils suivent
 * le compte d'un appareil à l'autre. Un signet est une page : l'adresse du début de la page (EPUB CFI),
 * l'avancement dans le livre, le titre du chapitre et quelques mots du texte, pour la liste.
 */

export interface BookBookmark {
  cfi: string;
  fraction: number;
  chapter: string;
  excerpt: string;
  createdAt: number;
}

/** Une borne par livre : au-delà, le plus ancien laisse sa place. */
export const MAX_BOOKMARKS = 500;

interface Row {
  cfi: string;
  fraction: number;
  chapter: string;
  excerpt: string;
  created_at: number;
}

const clean = (s: unknown, max: number) =>
  typeof s === "string"
    ? s
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** Une demande d'écriture valide, ou `null`. `remove` : retirer le signet de cette adresse. */
export function validBookmarkInput(body: unknown): { cfi: string; fraction: number; chapter: string; excerpt: string; remove: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.cfi !== "string" || o.cfi.length > 2000 || !/^epubcfi\([^\u0000-\u001f]+\)$/.test(o.cfi)) return null;
  const remove = o.remove === true;
  const fraction = typeof o.fraction === "number" && Number.isFinite(o.fraction) ? Math.min(1, Math.max(0, o.fraction)) : remove ? 0 : NaN;
  if (Number.isNaN(fraction)) return null;
  return { cfi: o.cfi, fraction, chapter: clean(o.chapter, 200), excerpt: clean(o.excerpt, 240), remove };
}

export function listBookmarks(account: string, itemId: string): BookBookmark[] {
  const rows = getDb()
    .prepare("SELECT cfi, fraction, chapter, excerpt, created_at FROM book_bookmarks WHERE account = ? AND item_id = ? ORDER BY fraction, created_at")
    .all(account, itemId) as Row[];
  return rows.map((r) => ({ cfi: r.cfi, fraction: r.fraction, chapter: r.chapter, excerpt: r.excerpt, createdAt: r.created_at }));
}

export function addBookmark(account: string, itemId: string, b: { cfi: string; fraction: number; chapter: string; excerpt: string }, now = Date.now()): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO book_bookmarks (account, item_id, cfi, fraction, chapter, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, item_id, cfi) DO UPDATE SET fraction = excluded.fraction, chapter = excluded.chapter, excerpt = excluded.excerpt`
    ).run(account, itemId, b.cfi, b.fraction, b.chapter, b.excerpt, now);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM book_bookmarks WHERE account = ? AND item_id = ?").get(account, itemId) as { n: number }).n;
    if (count > MAX_BOOKMARKS) {
      db.prepare(
        "DELETE FROM book_bookmarks WHERE rowid IN (SELECT rowid FROM book_bookmarks WHERE account = ? AND item_id = ? ORDER BY created_at LIMIT ?)"
      ).run(account, itemId, count - MAX_BOOKMARKS);
    }
  })();
}

/** Les livres où ce compte a au moins un signet. */
export function bookmarkedBooks(account: string): string[] {
  return (getDb().prepare("SELECT DISTINCT item_id FROM book_bookmarks WHERE account = ?").all(account) as { item_id: string }[]).map((r) => r.item_id);
}

export function removeBookmark(account: string, itemId: string, cfi: string): void {
  getDb().prepare("DELETE FROM book_bookmarks WHERE account = ? AND item_id = ? AND cfi = ?").run(account, itemId, cfi);
}

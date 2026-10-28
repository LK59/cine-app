import { getDb } from "@/lib/db";
import type { BookProgress } from "@/lib/books/types";

/**
 * Où en est chaque compte dans chaque livre (DECISIONS.md §127) — la table `book_progress`.
 *
 * Gardée ici et non chez Jellyfin : une position de livre est une adresse dans le texte (EPUB CFI),
 * que Jellyfin ne sait pas tenir — ses positions sont des durées. Rangée sous le nom du compte de
 * l'application (`session.u`), comme la langue retenue par série. Seul « lu » remonte à Jellyfin, à la
 * fin du livre, pour que ses autres applications le sachent aussi.
 */

interface Row {
  item_id: string;
  cfi: string;
  fraction: number;
  updated_at: number;
  finished_at: number | null;
}

const toProgress = (row: Row): BookProgress => ({
  cfi: row.cfi,
  fraction: row.fraction,
  updatedAt: row.updated_at,
  finished: row.finished_at !== null,
});

/** Les positions d'un compte, par livre. */
export function progressByBook(account: string): Map<string, BookProgress> {
  const rows = getDb().prepare("SELECT item_id, cfi, fraction, updated_at, finished_at FROM book_progress WHERE account = ?").all(account) as Row[];
  return new Map(rows.map((row) => [row.item_id, toProgress(row)]));
}

export function readProgress(account: string, itemId: string): BookProgress | null {
  const row = getDb()
    .prepare("SELECT item_id, cfi, fraction, updated_at, finished_at FROM book_progress WHERE account = ? AND item_id = ?")
    .get(account, itemId) as Row | undefined;
  return row ? toProgress(row) : null;
}

/**
 * Écrit la position. `finished` : le lecteur a montré la dernière page — la date est gardée la
 * première fois seulement. Rend `true` quand c'est cette écriture-ci qui termine le livre (la route
 * le note alors chez Jellyfin, une fois).
 */
export function saveProgress(account: string, itemId: string, cfi: string, fraction: number, finished: boolean, now = Date.now()): { firstFinish: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const before = db.prepare("SELECT finished_at FROM book_progress WHERE account = ? AND item_id = ?").get(account, itemId) as { finished_at: number | null } | undefined;
    const finishedAt = before?.finished_at ?? (finished ? now : null);
    db.prepare(
      `INSERT INTO book_progress (account, item_id, cfi, fraction, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, item_id) DO UPDATE SET cfi = excluded.cfi, fraction = excluded.fraction,
         updated_at = excluded.updated_at, finished_at = excluded.finished_at`
    ).run(account, itemId, cfi, fraction, now, finishedAt);
    return { firstFinish: finished && (before?.finished_at ?? null) === null };
  })();
}

/** Une position plausible : une CFI EPUB bornée, une fraction entre 0 et 1. */
export function validProgressInput(body: unknown): { cfi: string; fraction: number; finished: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const { cfi, fraction, finished } = body as Record<string, unknown>;
  if (typeof cfi !== "string" || cfi.length > 4000 || !/^epubcfi\(.+\)$/.test(cfi)) return null;
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  return { cfi, fraction, finished: finished === true };
}

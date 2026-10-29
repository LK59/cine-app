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
  dismissed_at: number | null;
}

const toProgress = (row: Row): BookProgress => ({
  cfi: row.cfi,
  fraction: row.fraction,
  updatedAt: row.updated_at,
  finished: row.finished_at !== null,
  dismissed: row.dismissed_at !== null,
});

/** Les positions d'un compte, par livre. */
export function progressByBook(account: string): Map<string, BookProgress> {
  const rows = getDb().prepare("SELECT item_id, cfi, fraction, updated_at, finished_at, dismissed_at FROM book_progress WHERE account = ?").all(account) as Row[];
  return new Map(rows.map((row) => [row.item_id, toProgress(row)]));
}

export function readProgress(account: string, itemId: string): BookProgress | null {
  const row = getDb()
    .prepare("SELECT item_id, cfi, fraction, updated_at, finished_at, dismissed_at FROM book_progress WHERE account = ? AND item_id = ?")
    .get(account, itemId) as Row | undefined;
  return row ? toProgress(row) : null;
}

export { MIN_STARTED_FRACTION } from "@/lib/books/types";

/**
 * Le lecteur est revenu à la première page et a refermé (`MIN_STARTED_FRACTION`) : le livre redevient
 * « pas commencé » — sa position est effacée, il quitte « Continuer la lecture » et rouvrira au début, là
 * où on l'a laissé. Les signets sont dans leur propre table : ils restent. Un livre déjà terminé garde
 * sa ligne (il reste « lu ») ; rien n'y est changé. Rend `true` si une position a été effacée.
 */
export function forgetUnstarted(account: string, itemId: string): boolean {
  return getDb().prepare("DELETE FROM book_progress WHERE account = ? AND item_id = ? AND finished_at IS NULL").run(account, itemId).changes > 0;
}

/**
 * Écrit la position. `finished` : le lecteur montre la dernière page — la date est gardée tant qu'il y
 * reste. « Terminé » dit où en est la lecture, pas ce qui est arrivé un jour : il tombe dès qu'une page
 * d'avant est enregistrée. Il ne tombait jamais (29/10/2026) — glisser la barre jusqu'au bout pour voir ce
 * qui restait sortait le livre de « Continuer la lecture » et le faisait rouvrir au début pour toujours,
 * et une relecture ne reprenait jamais sa page. « Lu » chez Jellyfin, lui, reste. Rend `true` quand c'est
 * cette écriture-ci qui termine le livre (la route le note alors chez Jellyfin).
 * `now` : l'heure de lecture, dans l'horloge du serveur (`readAt` de la route).
 */
export function saveProgress(
  account: string,
  itemId: string,
  cfi: string,
  fraction: number,
  finished: boolean,
  now = Date.now(),
  device: string | null = null
): { firstFinish: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const before = db.prepare("SELECT finished_at FROM book_progress WHERE account = ? AND item_id = ?").get(account, itemId) as { finished_at: number | null } | undefined;
    const finishedAt = finished ? (before?.finished_at ?? now) : null;
    // `device` : l'appareil de cette page (§129, l'activité dit « lu en dernier sur… ») ; inconnu, celui
    // d'avant reste.
    db.prepare(
      `INSERT INTO book_progress (account, item_id, cfi, fraction, updated_at, finished_at, last_device)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, item_id) DO UPDATE SET cfi = excluded.cfi, fraction = excluded.fraction,
         updated_at = excluded.updated_at, finished_at = excluded.finished_at, dismissed_at = NULL,
         last_device = COALESCE(excluded.last_device, book_progress.last_device)`
    ).run(account, itemId, cfi, fraction, now, finishedAt, device);
    return { firstFinish: finished && (before?.finished_at ?? null) === null };
  })();
}

/**
 * « Retirer de Continuer la lecture » : la position reste (le livre rouvre où il en était), mais il
 * quitte la rangée jusqu'à la prochaine page lue, qui l'y remet (`saveProgress`). Rend l'heure posée,
 * ou `null` s'il n'y avait pas de position.
 */
export function dismissProgress(account: string, itemId: string, now = Date.now()): number | null {
  const changed = getDb().prepare("UPDATE book_progress SET dismissed_at = ? WHERE account = ? AND item_id = ?").run(now, account, itemId).changes;
  return changed > 0 ? now : null;
}

/** L'heure du retrait, si le livre est retiré de la rangée. */
export function dismissedAt(account: string, itemId: string): number | null {
  const row = getDb().prepare("SELECT dismissed_at FROM book_progress WHERE account = ? AND item_id = ?").get(account, itemId) as { dismissed_at: number | null } | undefined;
  return row?.dismissed_at ?? null;
}

/** Une position plausible : une CFI EPUB bornée, une fraction entre 0 et 1. */
export function validProgressInput(body: unknown): { cfi: string; fraction: number; finished: boolean; at: number | null; ageMs: number | null; atStart: boolean | null } | null {
  if (!body || typeof body !== "object") return null;
  const { cfi, fraction, finished, at, ageMs, atStart } = body as Record<string, unknown>;
  if (typeof cfi !== "string" || cfi.length > 4000 || !/^epubcfi\(.+\)$/.test(cfi)) return null;
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  // `at` : l'heure de lecture dans l'horloge de l'appareil ; `ageMs` : depuis combien de temps, mesuré par
  // l'appareil au moment d'envoyer — la seule des deux que le serveur peut placer dans sa propre horloge.
  return {
    cfi,
    fraction,
    finished: finished === true,
    at: typeof at === "number" && Number.isFinite(at) ? at : null,
    ageMs: typeof ageMs === "number" && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= MAX_AGE_MS ? ageMs : null,
    // `null` : un client d'avant le 29/10/2026, qui ne le dit pas — la route garde pour lui le seuil de 1 %.
    atStart: typeof atStart === "boolean" ? atStart : null,
  };
}

/** Une position lue hors ligne il y a plus d'un an n'est plus datée : elle compte comme lue maintenant. */
const MAX_AGE_MS = 365 * 24 * 3_600_000;

/**
 * L'heure de lecture d'une position, dans l'horloge du serveur — celle de `updated_at` et `dismissed_at`.
 * L'heure de l'appareil comparée à celle du serveur (29/10/2026) : un appareil qui retardait voyait ses
 * positions jetées en silence, un appareil qui avançait remettait dans « Continuer la lecture » un livre
 * qu'on venait d'en retirer. Un ancien client n'envoie que `at` : elle sert, faute de mieux.
 */
export function readAt(input: { at: number | null; ageMs: number | null }, now = Date.now()): number | null {
  if (input.ageMs !== null) return now - input.ageMs;
  return input.at;
}

export interface AccountBookProgress {
  account: string;
  itemId: string;
  fraction: number;
  updatedAt: number;
  finishedAt: number | null;
  dismissed: boolean;
  lastDevice: string | null;
}

/**
 * Toutes les positions de tous les comptes, pour l'activité de l'administrateur (§129) — les plus récentes
 * d'abord, bornées : une ligne par compte et par livre, jamais le texte (la CFI n'en sort pas).
 */
export function allProgress(limit = 5000): AccountBookProgress[] {
  const rows = getDb()
    .prepare("SELECT account, item_id, fraction, updated_at, finished_at, dismissed_at, last_device FROM book_progress ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as { account: string; item_id: string; fraction: number; updated_at: number; finished_at: number | null; dismissed_at: number | null; last_device: string | null }[];
  return rows.map((r) => ({
    account: r.account,
    itemId: r.item_id,
    fraction: r.fraction,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    dismissed: r.dismissed_at !== null,
    lastDevice: r.last_device,
  }));
}

/**
 * « Marquer comme lu » (fiche du livre, 29/10/2026) : un livre lu ailleurs — papier, liseuse — ou fini sans
 * passer par la dernière page. Il devient terminé comme au bout du lecteur : hors de « Continuer la
 * lecture », et une prochaine ouverture repart du début (une relecture, qui le « détermine » à sa première
 * page enregistrée, `saveProgress`). La position gardée reste ; sans position, une ligne vide la porte.
 * Rend `true` si le livre ne l'était pas encore.
 */
export function markRead(account: string, itemId: string, now = Date.now()): boolean {
  const db = getDb();
  return db.transaction(() => {
    const before = db.prepare("SELECT finished_at FROM book_progress WHERE account = ? AND item_id = ?").get(account, itemId) as { finished_at: number | null } | undefined;
    if (before) {
      db.prepare("UPDATE book_progress SET fraction = 1, finished_at = COALESCE(finished_at, ?), updated_at = ?, dismissed_at = NULL WHERE account = ? AND item_id = ?").run(now, now, account, itemId);
    } else {
      db.prepare("INSERT INTO book_progress (account, item_id, cfi, fraction, updated_at, finished_at) VALUES (?, ?, '', 1, ?, ?)").run(account, itemId, now, now);
    }
    return (before?.finished_at ?? null) === null;
  })();
}

/**
 * « Marquer comme non lu » : le livre repart de zéro — ni terminé, ni commencé, sa position effacée. Les
 * signets, dans leur propre table, restent. Rend `true` s'il y avait quelque chose à effacer.
 */
export function markUnread(account: string, itemId: string): boolean {
  return getDb().prepare("DELETE FROM book_progress WHERE account = ? AND item_id = ?").run(account, itemId).changes > 0;
}

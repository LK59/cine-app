import { allProgress } from "@/lib/books/progress";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";
import { readRecords, type LogRecord } from "@/lib/activity/logReader";

/**
 * Les lectures de livres vues de l'activité (DECISIONS.md §129) — pour l'administrateur seul.
 *
 * Deux sources, chacune pour ce qu'elle sait : `book_progress` dit où chaque compte en est (livres en
 * cours, livres terminés et quand, l'appareil de la dernière page) ; `lectures.log` dit combien de temps
 * on a lu et combien de fois, sur sept et trente jours. Les titres viennent de l'index commun des livres
 * (passé par l'appelant), sinon de la dernière ligne du journal qui nomme le livre — un livre retiré de
 * la bibliothèque garde ainsi son nom dans l'historique.
 */

const DAY = 86_400_000;
const MAX_PER_ACCOUNT = 50;

export interface ReadingBook {
  id: string;
  title: string | null;
  author: string | null;
  fraction: number;
  /** La dernière page lue (en cours) ou la fin (terminé). */
  at: number;
  device: string | null;
}

export interface ReadingTotals {
  ms: number;
  sessions: number;
}

export interface ReadingAccount {
  account: string;
  inProgress: ReadingBook[];
  finished: ReadingBook[];
  week: ReadingTotals;
  month: ReadingTotals;
  lastReadAt: number | null;
}

export interface ReadingEventView {
  at: number;
  kind: string;
  account: string;
  title: string | null;
  durationMs: number | null;
  device: string | null;
  deviceType: string | null;
  offline: boolean;
}

export interface ReadingsOverview {
  now: number;
  accounts: ReadingAccount[];
  recent: ReadingEventView[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** L'instant d'une séance : sa fin dans l'horloge du serveur (une séance renvoyée tard est placée où elle a eu lieu). */
function sessionTime(r: LogRecord): number {
  const ended = typeof r.endedAt === "string" ? Date.parse(r.endedAt) : NaN;
  return Number.isFinite(ended) ? ended : r._t;
}

export function readingsOverview(books: ReadonlyMap<string, Pick<BookSummary, "name" | "seriesName" | "index" | "authors">>, now = Date.now(), records?: LogRecord[]): ReadingsOverview {
  const lines = (records ?? readRecords("readings", now - 30 * DAY)).filter((r) => typeof r.account === "string");
  // Le nom d'un livre d'après le journal, pour ceux que l'index ne connaît plus.
  const logged = new Map<string, { title: string | null; author: string | null }>();
  for (const r of lines) if (typeof r.book === "string" && str(r.title)) logged.set(r.book, { title: str(r.title), author: str(r.author) });
  const named = (id: string) => {
    const b = books.get(id);
    if (b) return { title: displayTitle(b), author: b.authors[0] ?? null };
    return logged.get(id) ?? { title: null, author: null };
  };

  const byAccount = new Map<string, ReadingAccount>();
  const accountOf = (account: string): ReadingAccount => {
    let a = byAccount.get(account);
    if (!a) {
      a = { account, inProgress: [], finished: [], week: { ms: 0, sessions: 0 }, month: { ms: 0, sessions: 0 }, lastReadAt: null };
      byAccount.set(account, a);
    }
    return a;
  };

  for (const p of allProgress()) {
    const a = accountOf(p.account);
    const book: ReadingBook = { id: p.itemId, ...named(p.itemId), fraction: p.fraction, at: p.finishedAt ?? p.updatedAt, device: p.lastDevice };
    if (p.finishedAt !== null) {
      if (a.finished.length < MAX_PER_ACCOUNT) a.finished.push(book);
    } else if (a.inProgress.length < MAX_PER_ACCOUNT) a.inProgress.push(book);
    a.lastReadAt = Math.max(a.lastReadAt ?? 0, p.updatedAt);
  }

  const recent: ReadingEventView[] = [];
  for (const r of lines) {
    const account = r.account as string;
    const at = sessionTime(r);
    // L'archive qui chevauche la limite est lue en entier (`readRecords`) : ce qui la précède est laissé.
    if (at < now - 30 * DAY) continue;
    if (r.kind === "séance") {
      const a = accountOf(account);
      const ms = num(r.durationMs) ?? 0;
      a.month.ms += ms;
      a.month.sessions += 1;
      if (at >= now - 7 * DAY) {
        a.week.ms += ms;
        a.week.sessions += 1;
      }
      a.lastReadAt = Math.max(a.lastReadAt ?? 0, at);
    }
    recent.push({
      at,
      kind: String(r.kind ?? "?"),
      account,
      title: str(r.title) ?? (typeof r.book === "string" ? named(r.book).title : null),
      durationMs: num(r.durationMs),
      device: str(r.device),
      deviceType: str(r.deviceType),
      offline: r.offline === true,
    });
  }
  // Les plus récents d'abord ; les terminés par date de fin.
  for (const a of byAccount.values()) a.finished.sort((x, y) => y.at - x.at);
  recent.sort((x, y) => y.at - x.at);
  return {
    now,
    accounts: [...byAccount.values()].sort((x, y) => (y.lastReadAt ?? 0) - (x.lastReadAt ?? 0) || x.account.localeCompare(y.account)),
    recent: recent.slice(0, 60),
  };
}

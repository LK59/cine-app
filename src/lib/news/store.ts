import { getDb } from "@/lib/db";
import { sanitizeByLang, type NewsContentByLang, type NewsPageView, type NewsPayload } from "./content";

/**
 * Les Nouveautés en base (DECISIONS.md §73) : les pages, et où en est chaque compte.
 *
 * **Le modèle** : chaque page publiée reçoit un numéro d'ordre croissant (`seq`) ; chaque compte
 * retient le dernier qu'il a vu (`seen_seq`). Ce qui reste à voir, ce sont les pages publiées au-delà.
 * Un compte qu'on n'a jamais croisé reçoit sa ligne à son premier passage, réglée juste sous la
 * dernière page publiée : il voit celle-là, pas tout l'historique fusionné. « Relancer » redescend
 * ce numéro sous la dernière page — jamais plus bas : un compte en retard de deux pages le reste.
 *
 * Le compte est le nom de la session (`session.u`), comme l'écran d'accueil (`onboardingDb`).
 */

export type NewsStatus = "draft" | "published";

export interface NewsPageRow {
  id: number;
  version: string;
  content: NewsContentByLang;
  status: NewsStatus;
  seq: number | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

export interface NewsStateRow {
  user: string;
  seenSeq: number;
  createdAt: number;
  shownAt: number | null;
  shownIds: number[];
  shownMs: number | null;
  closedBy: string | null;
  scrolled: boolean | null;
  auto: boolean | null;
  seeMoreAt: number | null;
  pageAt: number | null;
  pageMs: number | null;
  pageSection: string | null;
  rearmedAt: number | null;
}

interface PageRaw {
  id: number;
  version: string;
  content: string;
  status: string;
  seq: number | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

interface StateRaw {
  user_name: string;
  seen_seq: number;
  created_at: number;
  shown_at: number | null;
  shown_ids: string | null;
  shown_ms: number | null;
  closed_by: string | null;
  scrolled: number | null;
  auto: number | null;
  see_more_at: number | null;
  page_at: number | null;
  page_ms: number | null;
  page_section: string | null;
  rearmed_at: number | null;
}

function parseContent(text: string): NewsContentByLang {
  try {
    return sanitizeByLang(JSON.parse(text));
  } catch {
    // Une ligne illisible ne doit pas emporter la fenêtre de tout le monde : une page vide.
    return sanitizeByLang({});
  }
}

const toPage = (r: PageRaw): NewsPageRow => ({
  id: r.id,
  version: r.version,
  content: parseContent(r.content),
  status: r.status === "published" ? "published" : "draft",
  seq: r.seq,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  publishedAt: r.published_at,
});

function parseIds(text: string | null): number[] {
  try {
    const v = JSON.parse(text ?? "[]");
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

const toState = (r: StateRaw): NewsStateRow => ({
  user: r.user_name,
  seenSeq: r.seen_seq,
  createdAt: r.created_at,
  shownAt: r.shown_at,
  shownIds: parseIds(r.shown_ids),
  shownMs: r.shown_ms,
  closedBy: r.closed_by,
  scrolled: r.scrolled === null ? null : r.scrolled === 1,
  auto: r.auto === null ? null : r.auto === 1,
  seeMoreAt: r.see_more_at,
  pageAt: r.page_at,
  pageMs: r.page_ms,
  pageSection: r.page_section,
  rearmedAt: r.rearmed_at,
});

export function toView(p: NewsPageRow): NewsPageView {
  return { id: p.id, seq: p.seq ?? 0, version: p.version, publishedAt: p.publishedAt ?? p.createdAt, content: p.content };
}

export const newsDb = {
  /** Toutes les pages, brouillons compris : les publiées par ordre décroissant, puis les brouillons. */
  all(): NewsPageRow[] {
    return (getDb().prepare("SELECT * FROM news_pages ORDER BY seq IS NULL, seq DESC, id DESC").all() as PageRaw[]).map(toPage);
  },
  published(): NewsPageRow[] {
    return (getDb().prepare("SELECT * FROM news_pages WHERE status = 'published' ORDER BY seq DESC").all() as PageRaw[]).map(toPage);
  },
  get(id: number): NewsPageRow | null {
    const r = getDb().prepare("SELECT * FROM news_pages WHERE id = ?").get(id) as PageRaw | undefined;
    return r ? toPage(r) : null;
  },
  latestSeq(): number {
    return (getDb().prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM news_pages WHERE status = 'published'").get() as { m: number }).m;
  },
  create(version: string, content: NewsContentByLang, now = Date.now()): number {
    const info = getDb()
      .prepare("INSERT INTO news_pages (version, content, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)")
      .run(version, JSON.stringify(content), now, now);
    return Number(info.lastInsertRowid);
  },
  /** Brouillon ou publiée : corriger une coquille ne republie rien et ne réarme personne. */
  update(id: number, version: string, content: NewsContentByLang, now = Date.now()): boolean {
    return getDb().prepare("UPDATE news_pages SET version = ?, content = ?, updated_at = ? WHERE id = ?").run(version, JSON.stringify(content), now, id).changes > 0;
  },
  remove(id: number): boolean {
    return getDb().prepare("DELETE FROM news_pages WHERE id = ?").run(id).changes > 0;
  },
  /**
   * Publier : la page prend le numéro suivant, donc chaque compte — dont le dernier vu est forcément
   * plus bas — l'a désormais à voir. Republier une page déjà publiée ne change rien.
   */
  publish(id: number, now = Date.now()): number | null {
    const db = getDb();
    return db.transaction(() => {
      const page = db.prepare("SELECT status, seq FROM news_pages WHERE id = ?").get(id) as { status: string; seq: number | null } | undefined;
      if (!page) return null;
      if (page.status === "published" && page.seq !== null) return page.seq;
      const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM news_pages").get() as { m: number }).m + 1;
      db.prepare("UPDATE news_pages SET status = 'published', seq = ?, published_at = ?, updated_at = ? WHERE id = ?").run(seq, now, now, id);
      return seq;
    })();
  },

  /** L'état du compte, créé à son premier passage juste sous la dernière page publiée. */
  stateOf(user: string, now = Date.now()): NewsStateRow {
    const db = getDb();
    const found = db.prepare("SELECT * FROM news_state WHERE user_name = ?").get(user) as StateRaw | undefined;
    if (found) return toState(found);
    const seen = Math.max(0, newsDb.latestSeq() - 1);
    db.prepare("INSERT OR IGNORE INTO news_state (user_name, seen_seq, created_at) VALUES (?, ?, ?)").run(user, seen, now);
    return toState(db.prepare("SELECT * FROM news_state WHERE user_name = ?").get(user) as StateRaw);
  },
  states(): Map<string, NewsStateRow> {
    const rows = getDb().prepare("SELECT * FROM news_state").all() as StateRaw[];
    return new Map(rows.map((r) => [r.user_name, toState(r)]));
  },
  /** La fenêtre vient de s'afficher : le drapeau s'éteint, quelle que soit la façon dont elle se fermera. */
  markSeen(user: string, ids: number[], now = Date.now()): void {
    const db = getDb();
    newsDb.stateOf(user, now);
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(",");
    const top = (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM news_pages WHERE status = 'published' AND id IN (${marks})`).get(...ids) as { m: number }).m;
    db.prepare("UPDATE news_state SET seen_seq = MAX(seen_seq, ?), shown_at = ?, shown_ids = ? WHERE user_name = ?").run(top, now, JSON.stringify(ids), user);
  },
  noteWindow(user: string, m: { shownMs: number; closedBy: string; scrolled: boolean; auto: boolean }, now = Date.now()): void {
    newsDb.stateOf(user, now);
    getDb()
      .prepare("UPDATE news_state SET shown_ms = ?, closed_by = ?, scrolled = ?, auto = ?, shown_at = COALESCE(shown_at, ?) WHERE user_name = ?")
      .run(m.shownMs, m.closedBy, m.scrolled ? 1 : 0, m.auto ? 1 : 0, now, user);
  },
  noteSeeMore(user: string, now = Date.now()): void {
    newsDb.stateOf(user, now);
    getDb().prepare("UPDATE news_state SET see_more_at = ? WHERE user_name = ?").run(now, user);
  },
  notePage(user: string, m: { shownMs: number; section: string }, now = Date.now()): void {
    newsDb.stateOf(user, now);
    getDb().prepare("UPDATE news_state SET page_at = ?, page_ms = ?, page_section = ? WHERE user_name = ?").run(now, m.shownMs, m.section, user);
  },
  /**
   * Relancer la dernière page : pour un compte, ou pour tous ceux que la table connaît (`users`
   * absent) — un compte sans ligne l'a déjà à voir. Les mesures du dernier affichage sont effacées,
   * pour que la vue de l'administrateur dise ce que la relance a donné et non ce qui l'a précédée.
   */
  relaunch(users: string[] | null, now = Date.now()): number {
    const db = getDb();
    const below = Math.max(0, newsDb.latestSeq() - 1);
    const reset = "seen_seq = MIN(seen_seq, ?), rearmed_at = ?, shown_ms = NULL, closed_by = NULL, scrolled = NULL, auto = NULL, see_more_at = NULL";
    if (users === null) return db.prepare(`UPDATE news_state SET ${reset}`).run(below, now).changes;
    let n = 0;
    db.transaction(() => {
      for (const user of users) {
        newsDb.stateOf(user, now);
        n += db.prepare(`UPDATE news_state SET ${reset} WHERE user_name = ?`).run(below, now, user).changes;
      }
    })();
    return n;
  },
};

/** Ce que `/api/release-notes` répond : les pages publiées, celles qui restent à voir, et si c'est une relance. */
export function newsFor(user: string, now = Date.now()): NewsPayload {
  const state = newsDb.stateOf(user, now);
  const pages = newsDb.published().map(toView);
  const unseen = pages.filter((p) => p.seq > state.seenSeq).map((p) => p.id);
  return {
    pages,
    unseen,
    relaunched: state.rearmedAt !== null && (state.shownAt === null || state.rearmedAt > state.shownAt),
  };
}

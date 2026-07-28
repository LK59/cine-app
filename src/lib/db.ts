import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getDefaultNotificationPreferences, type NotificationCategory } from "@/lib/notifications";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH  = path.join(DATA_DIR, "cine.db");

// ─── Singleton ────────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

// ─── Schema migrations ────────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      media_type   TEXT    NOT NULL CHECK (media_type IN ('movie', 'series')),
      tmdb_id      INTEGER NOT NULL,
      tvdb_id      INTEGER,
      title        TEXT    NOT NULL,
      year         INTEGER,
      poster_path  TEXT,
      status       TEXT    NOT NULL DEFAULT 'to_watch'
                   CHECK (status IN ('to_watch','to_request','favorite','watched','abandoned')),
      note         TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE (user_id, media_type, tmdb_id)
    );

    CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist (user_id);
    CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist (user_id, status);

    CREATE TABLE IF NOT EXISTS timeline_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type   TEXT    NOT NULL,
      tmdb_id      INTEGER NOT NULL,
      tvdb_id      INTEGER,
      title        TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      event_date   INTEGER NOT NULL,
      source       TEXT    NOT NULL,
      detail       TEXT,
      user_id      TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_timeline_media ON timeline_events (media_type, tmdb_id);
    CREATE INDEX IF NOT EXISTS idx_timeline_date  ON timeline_events (event_date DESC);

    CREATE TABLE IF NOT EXISTS recommendations_hidden (
      user_id    TEXT    NOT NULL,
      tmdb_id    INTEGER NOT NULL,
      media_type TEXT    NOT NULL,
      hidden_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, tmdb_id, media_type)
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT    NOT NULL,
      endpoint   TEXT    NOT NULL UNIQUE,
      p256dh     TEXT    NOT NULL,
      auth       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);

    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id    TEXT    NOT NULL,
      category   TEXT    NOT NULL,
      enabled    INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, category)
    );

    CREATE TABLE IF NOT EXISTS availability_notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type  TEXT    NOT NULL,
      tmdb_id     INTEGER NOT NULL,
      notified_at INTEGER NOT NULL,
      UNIQUE(media_type, tmdb_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      jti          TEXT    PRIMARY KEY,
      user_id      TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

    CREATE TABLE IF NOT EXISTS kv_cache (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);

  // Additive migrations — safe to run multiple times
  try { db.exec("ALTER TABLE watchlist ADD COLUMN vote_average REAL"); } catch { /* already exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id    TEXT    PRIMARY KEY,
      lang       TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
}

// ─── User preferences ─────────────────────────────────────────────────────────

export const userPrefsDb = {
  getLang(userId: string, instanceDefault: string): string {
    const row = getDb()
      .prepare("SELECT lang FROM user_preferences WHERE user_id = ?")
      .get(userId) as { lang: string | null } | undefined;
    return row?.lang ?? instanceDefault;
  },

  setLang(userId: string, lang: string): void {
    getDb().prepare(`
      INSERT INTO user_preferences (user_id, lang, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET lang = excluded.lang, updated_at = excluded.updated_at
    `).run(userId, lang, Date.now());
  },
};

// ─── Watchlist helpers ────────────────────────────────────────────────────────

export interface WatchlistItem {
  id: number;
  userId: string;
  mediaType: "movie" | "series";
  tmdbId: number;
  tvdbId: number | null;
  title: string;
  year: number | null;
  posterPath: string | null;
  voteAverage: number | null;
  status: WatchlistStatus;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WatchlistStatus = "to_watch" | "to_request" | "favorite" | "watched" | "abandoned";

const SELECT_WATCHLIST = `
  SELECT
    id,
    user_id       AS userId,
    media_type    AS mediaType,
    tmdb_id       AS tmdbId,
    tvdb_id       AS tvdbId,
    title,
    year,
    poster_path   AS posterPath,
    vote_average  AS voteAverage,
    status,
    note,
    created_at    AS createdAt,
    updated_at    AS updatedAt
  FROM watchlist
`;

export const watchlistDb = {
  getAll(userId: string, status?: WatchlistStatus): WatchlistItem[] {
    const db = getDb();
    if (status) {
      return db.prepare(`${SELECT_WATCHLIST} WHERE user_id = ? AND status = ? ORDER BY updated_at DESC`).all(userId, status) as WatchlistItem[];
    }
    return db.prepare(`${SELECT_WATCHLIST} WHERE user_id = ? ORDER BY updated_at DESC`).all(userId) as WatchlistItem[];
  },

  get(userId: string, mediaType: string, tmdbId: number): WatchlistItem | null {
    const db = getDb();
    return (db.prepare(`${SELECT_WATCHLIST} WHERE user_id = ? AND media_type = ? AND tmdb_id = ?`).get(userId, mediaType, tmdbId) ?? null) as WatchlistItem | null;
  },

  upsert(item: Omit<WatchlistItem, "id" | "createdAt" | "updatedAt">): WatchlistItem {
    const db = getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO watchlist (user_id, media_type, tmdb_id, tvdb_id, title, year, poster_path, vote_average, status, note, created_at, updated_at)
      VALUES (@userId, @mediaType, @tmdbId, @tvdbId, @title, @year, @posterPath, @voteAverage, @status, @note, @now, @now)
      ON CONFLICT (user_id, media_type, tmdb_id) DO UPDATE SET
        status = excluded.status,
        note = excluded.note,
        poster_path = excluded.poster_path,
        vote_average = COALESCE(excluded.vote_average, vote_average),
        title = excluded.title,
        year = excluded.year,
        updated_at = excluded.updated_at
    `).run({ ...item, now });
    return this.get(item.userId, item.mediaType, item.tmdbId)!;
  },

  updateStatus(userId: string, id: number, status: WatchlistStatus, note?: string): boolean {
    const db = getDb();
    let r;
    if (note === undefined) {
      r = db.prepare("UPDATE watchlist SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(status, Date.now(), id, userId);
    } else {
      r = db.prepare("UPDATE watchlist SET status = ?, note = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(status, note || null, Date.now(), id, userId);
    }
    return r.changes > 0;
  },

  remove(userId: string, id: number): boolean {
    const db = getDb();
    const r = db.prepare("DELETE FROM watchlist WHERE id = ? AND user_id = ?").run(id, userId);
    return r.changes > 0;
  },

  isInWatchlist(userId: string, mediaType: string, tmdbId: number): boolean {
    const db = getDb();
    return !!(db.prepare("SELECT 1 FROM watchlist WHERE user_id = ? AND media_type = ? AND tmdb_id = ?").get(userId, mediaType, tmdbId));
  },

  // Bulk check — returns a Set of `${mediaType}:${tmdbId}` for quick lookup
  getBulkStatus(userId: string, ids: { mediaType: string; tmdbId: number }[]): Set<string> {
    if (!ids.length) return new Set();
    const db = getDb();
    const rows = db.prepare(
      "SELECT media_type, tmdb_id FROM watchlist WHERE user_id = ?"
    ).all(userId) as { media_type: string; tmdb_id: number }[];
    const all = new Set(rows.map((r) => `${r.media_type}:${r.tmdb_id}`));
    const result = new Set<string>();
    for (const { mediaType, tmdbId } of ids) {
      const key = `${mediaType}:${tmdbId}`;
      if (all.has(key)) result.add(key);
    }
    return result;
  },
};

// ─── Timeline helpers ─────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: number;
  mediaType: string;
  tmdbId: number;
  tvdbId: number | null;
  title: string;
  eventType: string;
  eventDate: number;
  source: string;
  detail: string | null;
  userId: string | null;
  createdAt: number;
}

export const timelineDb = {
  insertEvent(event: Omit<TimelineEvent, "id" | "createdAt">): void {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO timeline_events
        (media_type, tmdb_id, tvdb_id, title, event_type, event_date, source, detail, user_id, created_at)
      VALUES (@mediaType, @tmdbId, @tvdbId, @title, @eventType, @eventDate, @source, @detail, @userId, @now)
    `).run({ ...event, now: Date.now() });
  },

  getForMedia(mediaType: string, tmdbId: number, limit = 50): TimelineEvent[] {
    const db = getDb();
    return db.prepare("SELECT * FROM timeline_events WHERE media_type = ? AND tmdb_id = ? ORDER BY event_date DESC LIMIT ?")
      .all(mediaType, tmdbId, limit) as TimelineEvent[];
  },

  getGlobal(limit = 50): TimelineEvent[] {
    const db = getDb();
    return db.prepare("SELECT * FROM timeline_events ORDER BY event_date DESC LIMIT ?").all(limit) as TimelineEvent[];
  },
};

// ─── Recommendations hidden ───────────────────────────────────────────────────

export const recommendationsDb = {
  hide(userId: string, tmdbId: number, mediaType: string): void {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO recommendations_hidden (user_id, tmdb_id, media_type, hidden_at) VALUES (?,?,?,?)")
      .run(userId, tmdbId, mediaType, Date.now());
  },

  getHidden(userId: string): Set<string> {
    const db = getDb();
    const rows = db.prepare("SELECT tmdb_id, media_type FROM recommendations_hidden WHERE user_id = ?").all(userId) as { tmdb_id: number; media_type: string }[];
    return new Set(rows.map((r) => `${r.media_type}:${r.tmdb_id}`));
  },
};

// ─── Push subscriptions ───────────────────────────────────────────────────────

export interface PushSubscription {
  id: number;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
}

export const pushDb = {
  upsert(userId: string, endpoint: string, p256dh: string, auth: string): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
    `).run(userId, endpoint, p256dh, auth, Date.now());
  },

  remove(endpoint: string): void {
    getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  },

  removeByUser(userId: string): void {
    getDb().prepare("DELETE FROM push_subscriptions WHERE user_id = ?").run(userId);
  },

  removeByUserEndpointPrefix(userId: string, endpointPrefix: string): void {
    getDb().prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint LIKE ?").run(userId, `${endpointPrefix}%`);
  },

  getAll(): PushSubscription[] {
    return getDb().prepare("SELECT * FROM push_subscriptions").all() as PushSubscription[];
  },

  getByUser(userId: string): PushSubscription[] {
    return getDb().prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId) as PushSubscription[];
  },
};

// ─── Availability notifications ──────────────────────────────────────────────

export const availabilityNotifDb = {
  hasBeenNotified(mediaType: string, tmdbId: number): boolean {
    return !!getDb().prepare("SELECT 1 FROM availability_notifications WHERE media_type = ? AND tmdb_id = ?").get(mediaType, tmdbId);
  },
  markNotified(mediaType: string, tmdbId: number): void {
    getDb().prepare("INSERT OR REPLACE INTO availability_notifications (media_type, tmdb_id, notified_at) VALUES (?, ?, ?)").run(mediaType, tmdbId, Date.now());
  },
  cleanup(olderThanMs: number): void {
    getDb().prepare("DELETE FROM availability_notifications WHERE notified_at < ?").run(Date.now() - olderThanMs);
  },
};

// ─── Notification preferences ────────────────────────────────────────────────

export const notificationPrefsDb = {
  getForUser(userId: string): Record<NotificationCategory, boolean> {
    const defaults = getDefaultNotificationPreferences();
    const rows = getDb().prepare("SELECT category, enabled FROM notification_preferences WHERE user_id = ?").all(userId) as { category: string; enabled: number }[];
    for (const row of rows) {
      if (row.category in defaults) {
        defaults[row.category as NotificationCategory] = row.enabled === 1;
      }
    }
    return defaults;
  },

  set(userId: string, category: NotificationCategory, enabled: boolean): void {
    getDb().prepare(`
      INSERT INTO notification_preferences (user_id, category, enabled, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, category) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(userId, category, enabled ? 1 : 0, Date.now());
  },

  isEnabled(userId: string, category: NotificationCategory): boolean {
    return this.getForUser(userId)[category];
  },
};

// ─── Persistent KV cache ──────────────────────────────────────────────────────
// Backs the long-lived in-memory caches (TMDB credits, ratings, ...) with disk storage so a
// container restart (a frequent event around here — every redeploy) doesn't force a full
// cold-start refetch storm of hundreds of TMDB requests. See withPersistentCache in server-cache.ts.

export const kvCacheDb = {
  get(key: string): { value: unknown; fetchedAt: number } | null {
    const row = getDb().prepare("SELECT value, fetched_at FROM kv_cache WHERE key = ?").get(key) as
      | { value: string; fetched_at: number }
      | undefined;
    if (!row) return null;
    try {
      return { value: JSON.parse(row.value), fetchedAt: row.fetched_at };
    } catch {
      return null;
    }
  },

  set(key: string, value: unknown, fetchedAt: number): void {
    getDb().prepare(`
      INSERT INTO kv_cache (key, value, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at
    `).run(key, JSON.stringify(value), fetchedAt);
  },

  // Opportunistic cleanup — avoids unbounded growth from stale entries (removed movies, etc.)
  cleanup(maxAgeMs: number): void {
    getDb().prepare("DELETE FROM kv_cache WHERE fetched_at < ?").run(Date.now() - maxAgeMs);
  },
};

// ─── Session store ────────────────────────────────────────────────────────────

const SESSION_MAX_AGE_MS = 7 * 24 * 3600_000;

export const sessionDb = {
  create(jti: string, userId: string): void {
    const db = getDb();
    const now = Date.now();
    db.prepare("INSERT OR REPLACE INTO sessions (jti, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)").run(jti, userId, now, now);
    // Opportunistic cleanup of expired sessions
    db.prepare("DELETE FROM sessions WHERE last_seen_at < ?").run(now - SESSION_MAX_AGE_MS);
  },

  exists(jti: string): boolean {
    const db = getDb();
    return !!(db.prepare("SELECT 1 FROM sessions WHERE jti = ?").get(jti));
  },

  delete(jti: string): void {
    getDb().prepare("DELETE FROM sessions WHERE jti = ?").run(jti);
  },

  countOthers(userId: string, currentJti: string): number {
    const row = getDb().prepare("SELECT COUNT(*) as n FROM sessions WHERE user_id = ? AND jti != ?").get(userId, currentJti) as { n: number };
    return row.n;
  },

  deleteOthers(userId: string, currentJti: string): number {
    const r = getDb().prepare("DELETE FROM sessions WHERE user_id = ? AND jti != ?").run(userId, currentJti);
    return r.changes;
  },
};

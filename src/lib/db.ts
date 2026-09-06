import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getDefaultNotificationPreferences, type NotificationCategory } from "@/lib/notifications";

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
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

    -- One row per Jellyseerr request made through cine-app, until the notification cron finds
    -- it available and deletes the row (see checkRequestAvailability in notificationJobs.ts).
    -- Deliberately NOT sourced from Jellyseerr itself at check time (its own API is the fragile,
    -- session-auth-gated moving target this whole session kept running into) — this only ever
    -- reads the already-cached Radarr/Sonarr library data the watchlist-availability check also
    -- uses, so it can't be broken by anything Jellyseerr-side.
    CREATE TABLE IF NOT EXISTS request_notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT    NOT NULL,
      media_type TEXT    NOT NULL CHECK (media_type IN ('movie', 'series')),
      tmdb_id    INTEGER NOT NULL,
      seasons    TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      jti          TEXT    PRIMARY KEY,
      user_id      TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

    /* Ce qui a déjà été fait une fois et ne doit pas se refaire.
       Une migration de données par compte ne peut pas s'appuyer sur le schéma : elle dépend de
       comptes qui n'existent qu'une fois connectés. Il lui faut donc sa propre mémoire. */
    CREATE TABLE IF NOT EXISTS migrations_done (
      name    TEXT    PRIMARY KEY,
      done_at INTEGER NOT NULL
    );

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_checks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      service    TEXT    NOT NULL,
      status     TEXT    NOT NULL,
      latency_ms INTEGER,
      checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_service_checks ON service_checks (service, checked_at);

    CREATE TABLE IF NOT EXISTS capability_checks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      capability TEXT    NOT NULL,
      status     TEXT    NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capability_checks ON capability_checks (capability, checked_at);
  `);

  // Per-user opt-out, back to the server-side player.
  //
  // A new column rather than a reinterpretation of the old one, which meant the opposite: the
  // people who had opted into the new player are exactly the people who must not be sent back to
  // the old one, and inverting the stored values in place would have done precisely that to
  // whoever was mid-migration. Everybody starts at zero, which is now the new player, which is
  // what everybody gets.
  try { db.exec("ALTER TABLE user_preferences ADD COLUMN legacy_player INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  // La colonne a existé le temps d'une version qui révoquait le jeton Jellyfin en même temps que
  // la session. Ce n'est plus le cas — se déconnecter de Cine App ne doit pas toucher à Jellyfin —
  // et un secret qu'on ne lit plus n'a rien à faire au repos : elle est vidée à chaque démarrage.
  // `ALTER TABLE ... DROP COLUMN` n'existe pas dans les vieilles versions de SQLite ; l'effacer
  // suffit et ne demande pas de reconstruire la table.
  try { db.exec("UPDATE sessions SET jf_token = NULL WHERE jf_token IS NOT NULL"); } catch { /* colonne absente */ }
  // Two columns are left behind and nothing reads either: `experimental_player`, which asked the
  // question the other way round, and an older HDR consent flag. Both have defaults and dropping
  // a column rewrites the table, so they stay where they are.

  // The disk-saturation forecast switched from hourly df sampling to deriving straight from
  // library file mtimes (see diskForecast.ts) — no history to wait weeks for, and one less
  // cron/table to maintain. Drops the now-unused table from the brief window it existed in.
  db.exec("DROP TABLE IF EXISTS disk_usage_history");
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

  /** Whether this account has asked to go back to playback through the server. Off by default. */
  getLegacyPlayer(userId: string): { enabled: boolean } {
    const row = getDb()
      .prepare("SELECT legacy_player FROM user_preferences WHERE user_id = ?")
      .get(userId) as { legacy_player: number | null } | undefined;
    return { enabled: row?.legacy_player === 1 };
  },

  setLegacyPlayer(userId: string, enabled: boolean): void {
    getDb().prepare(`
      INSERT INTO user_preferences (user_id, lang, legacy_player, updated_at)
      VALUES (?, NULL, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        legacy_player = excluded.legacy_player,
        updated_at = excluded.updated_at
    `).run(userId, enabled ? 1 : 0, Date.now());
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

  // Bulk check — returns a Map of `${mediaType}:${tmdbId}` -> status for quick lookup,
  // for the subset of `ids` actually on the user's list.
  getBulkStatus(userId: string, ids: { mediaType: string; tmdbId: number }[]): Map<string, WatchlistStatus> {
    if (!ids.length) return new Map();
    const db = getDb();
    const rows = db.prepare(
      "SELECT media_type, tmdb_id, status FROM watchlist WHERE user_id = ?"
    ).all(userId) as { media_type: string; tmdb_id: number; status: WatchlistStatus }[];
    const all = new Map(rows.map((r) => [`${r.media_type}:${r.tmdb_id}`, r.status]));
    const result = new Map<string, WatchlistStatus>();
    for (const { mediaType, tmdbId } of ids) {
      const key = `${mediaType}:${tmdbId}`;
      const status = all.get(key);
      if (status) result.set(key, status);
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

// ─── Pending request notifications ───────────────────────────────────────────

export interface PendingRequest {
  id: number;
  userId: string;
  mediaType: "movie" | "series";
  tmdbId: number;
  /** null for a movie request; the specific season numbers requested for a series. */
  seasons: number[] | null;
}

export const pendingRequestDb = {
  add(userId: string, mediaType: "movie" | "series", tmdbId: number, seasons: number[] | null): void {
    getDb().prepare(
      "INSERT INTO request_notifications (user_id, media_type, tmdb_id, seasons, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(userId, mediaType, tmdbId, seasons ? JSON.stringify(seasons) : null, Date.now());
  },
  getAll(): PendingRequest[] {
    const rows = getDb().prepare(
      "SELECT id, user_id AS userId, media_type AS mediaType, tmdb_id AS tmdbId, seasons FROM request_notifications"
    ).all() as { id: number; userId: string; mediaType: "movie" | "series"; tmdbId: number; seasons: string | null }[];
    return rows.map((r) => ({ ...r, seasons: r.seasons ? (JSON.parse(r.seasons) as number[]) : null }));
  },
  remove(id: number): void {
    getDb().prepare("DELETE FROM request_notifications WHERE id = ?").run(id);
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

// ─── Status/health history (see src/lib/healthChecks.ts + statusCron.ts) ──────

export const statusHistoryDb = {
  recordServiceChecks(results: Record<string, { status: string; latencyMs: number | null }>, checkedAt: number): void {
    const db = getDb();
    const stmt = db.prepare("INSERT INTO service_checks (service, status, latency_ms, checked_at) VALUES (?, ?, ?, ?)");
    const tx = db.transaction((entries: [string, { status: string; latencyMs: number | null }][]) => {
      for (const [service, r] of entries) stmt.run(service, r.status, r.latencyMs, checkedAt);
    });
    tx(Object.entries(results));
  },

  recordCapabilityChecks(results: { id: string; status: string }[], checkedAt: number): void {
    const db = getDb();
    const stmt = db.prepare("INSERT INTO capability_checks (capability, status, checked_at) VALUES (?, ?, ?)");
    const tx = db.transaction((rows: { id: string; status: string }[]) => {
      for (const r of rows) stmt.run(r.id, r.status, checkedAt);
    });
    tx(results);
  },

  getCapabilityHistory(capability: string, sinceMs: number): { status: string; checkedAt: number }[] {
    return getDb()
      .prepare("SELECT status, checked_at as checkedAt FROM capability_checks WHERE capability = ? AND checked_at >= ? ORDER BY checked_at ASC")
      .all(capability, sinceMs) as { status: string; checkedAt: number }[];
  },

  // Opportunistic cleanup — keeps service_checks/capability_checks from growing forever.
  cleanup(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    const db = getDb();
    db.prepare("DELETE FROM service_checks WHERE checked_at < ?").run(cutoff);
    db.prepare("DELETE FROM capability_checks WHERE checked_at < ?").run(cutoff);
  },
};

// ─── Session store ────────────────────────────────────────────────────────────

const SESSION_MAX_AGE_MS = 7 * 24 * 3600_000;

export interface StoredSession {
  jti: string;
  createdAt: number;
  lastSeenAt: number;
}

/** Les migrations de données déjà passées, pour qu'elles ne repassent pas. */
export const migrationDb = {
  isDone(name: string): boolean {
    return !!getDb().prepare("SELECT 1 FROM migrations_done WHERE name = ?").get(name);
  },
  markDone(name: string): void {
    getDb().prepare("INSERT OR IGNORE INTO migrations_done (name, done_at) VALUES (?, ?)").run(name, Date.now());
  },
};

export const sessionDb = {
  create(jti: string, userId: string): void {
    const db = getDb();
    const now = Date.now();
    db.prepare("INSERT OR REPLACE INTO sessions (jti, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(jti, userId, now, now);
    // Opportunistic cleanup of expired sessions
    db.prepare("DELETE FROM sessions WHERE last_seen_at < ?").run(now - SESSION_MAX_AGE_MS);
  },

  /**
   * Marquer une session comme vue à l'instant.
   *
   * `last_seen_at` était écrit à la création et jamais ensuite : la colonne mentait, et le ménage
   * qui s'appuie dessus effaçait donc toute session sept jours après sa *création*, quel qu'ait
   * été son usage. Écrit seulement quand la valeur a franchi une heure, pour ne pas transformer
   * chaque requête en écriture.
   */
  touch(jti: string): void {
    const now = Date.now();
    getDb()
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE jti = ? AND last_seen_at < ?")
      .run(now, jti, now - 60 * 60 * 1000);
  },

  /** Les autres sessions de cette personne, la plus récente d'abord. */
  listOthers(userId: string, currentJti: string): StoredSession[] {
    const rows = getDb()
      .prepare("SELECT jti, created_at, last_seen_at FROM sessions WHERE user_id = ? AND jti != ? ORDER BY created_at DESC")
      .all(userId, currentJti) as { jti: string; created_at: number; last_seen_at: number }[];
    return rows.map((r) => ({ jti: r.jti, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
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

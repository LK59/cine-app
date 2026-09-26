import type { Top10Theme, Top10Memory } from "@/lib/cinemaRails";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getDefaultNotificationPreferences, type NotificationCategory } from "@/lib/notifications";
import { DATA_DIR } from "@/lib/dataDir";

// Réexporté, et défini ailleurs : le journal des erreurs a besoin du chemin et ne doit rien
// devoir à la base — voir `dataDir.ts`. Une seule écriture de la valeur, ici comme là-bas.
export { DATA_DIR };
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

    -- Deux tables que rien n'écrivait plus : timeline_events (lue par la notification
    -- « nouvel épisode », qui n'est donc jamais partie — elle lit l'historique de Sonarr depuis)
    -- et recommendations_hidden (la page Recommandations, supprimée). Vides en production au
    -- 21/09/2026 ; les laisser, c'est laisser croire qu'elles servent.
    DROP TABLE IF EXISTS timeline_events;
    DROP TABLE IF EXISTS recommendations_hidden;

    -- Une seule liste : « À voir ». favorite / watched vivent chez Jellyfin (« une place par
    -- fait »), to_request doublait les demandes Jellyseerr, abandoned n'a jamais servi. Les
    -- titres « à demander » et « favoris » restent dans la liste — ils y étaient déjà pour le
    -- panneau du lecteur, pas pour la rangée « Ma liste » : les deux écrans se contredisaient.
    -- Ce qui était « vu » ou « abandonné » n'est justement plus à voir. Idempotent et bon marché
    -- (l'index porte sur le statut), donc rejoué à chaque démarrage plutôt que noté une fois.
    UPDATE watchlist SET status = 'to_watch' WHERE status IN ('to_request', 'favorite');
    DELETE FROM watchlist WHERE status IN ('watched', 'abandoned');

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
  try { db.exec("ALTER TABLE maintenance ADD COLUMN expires_at INTEGER"); } catch { /* already exists */ }
  // « iPhone · Safari » — de quoi reconnaître une session dans le panneau Compte (voir `deviceLabel`).
  try { db.exec("ALTER TABLE sessions ADD COLUMN device TEXT"); } catch { /* already exists */ }
  // L'appareil que Jellyfin a inscrit pour cette connexion (`cine-app-<aléatoire>`) — pas un secret :
  // c'est ce qui permet, à la déconnexion, de supprimer cet appareil chez Jellyfin et le jeton avec
  // lui, sans jamais garder le jeton lui-même (voir `jellyfinRevoke.ts`).
  try { db.exec("ALTER TABLE sessions ADD COLUMN jf_device TEXT"); } catch { /* already exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id    TEXT    PRIMARY KEY,
      lang       TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    /* L'état d'exploitation annoncé aux spectateurs — une seule ligne, forcée par le CHECK.
       
       En base et non en mémoire, parce que le seul moment où ce drapeau sert est celui où le
       conteneur est recréé : l'administrateur l'allume *pour* redéployer. Un drapeau qui vit dans
       le processus s'éteindrait précisément à l'instant où il doit rester allumé, et le bandeau
       disparaîtrait de tous les écrans au début du redémarrage qu'il annonce. Le dossier data est le
       seul volume inscriptible, et il survit au conteneur. */
    CREATE TABLE IF NOT EXISTS maintenance (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      active    INTEGER NOT NULL DEFAULT 0,
      /* Date du dernier avis « redémarrage imminent », en ms. C'est elle que les lecteurs
         comparent à ce qu'ils ont déjà montré : une date qui avance est un nouvel avis, ce qui
         permet d'en envoyer plusieurs sans jamais réafficher le précédent. */
      notice_at INTEGER,
      /* Dans la création, et pas seulement dans la migration : celle-ci tourne avant la création,
         et sur une installation neuve elle échouait en silence — la maintenance ne répondait plus
         jusqu'au démarrage suivant (23/09/2026). */
      expires_at INTEGER
    )
  `);
  db.exec(`
    /* Le thème du palmarès du jour, une ligne par collection et par date.
       Le tirage se déduit entièrement de la date et n'a rien à stocker pour fonctionner — mais il
       se déduit aussi de la *bibliothèque*, et celle-ci est amputée tant que Jellyfin finit de
       démarrer : moins de titres, moins de thèmes assez fournis, autre palmarès. Un redémarrage en
       début de soirée changeait donc la sélection sous les yeux de tout le monde. La première
       réponse de la journée fait foi ; le reste de la journée la relit. */
    CREATE TABLE IF NOT EXISTS daily_top10 (
      kind  TEXT NOT NULL,
      day   TEXT NOT NULL,
      /* Le thème sérialisé, ou la chaîne vide quand ce jour-là n'en avait aucun — une absence
         décidée est une réponse, et elle doit tenir jusqu'à demain comme les autres. */
      theme TEXT NOT NULL,
      PRIMARY KEY (kind, day)
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

    /* Un second index sur la seule date, pour le ménage.
       
       Les deux index ci-dessus commencent par le nom du service : parfaits pour lire l'historique
       d'un service, inutiles pour « tout ce qui est plus vieux que telle date, tous services
       confondus ». Le plan de la suppression horaire était donc un SCAN de l'index entier — 1,3
       million d'entrées, une soixantaine de millisecondes pendant lesquelles better-sqlite3, qui
       est synchrone, tient toute la boucle d'événements. Ce n'était pas visible aujourd'hui ;
       c'était linéaire dans la taille de la table, donc c'était une question de temps.
       
       Trié par date, la suppression se positionne au point de coupe et efface un bloc contigu. Le
       même index sert la vue « quel service ralentit » ci-dessous, qui agrège elle aussi sur une
       fenêtre de temps sans distinguer les services. */
    CREATE INDEX IF NOT EXISTS idx_service_checks_time ON service_checks (checked_at);
    CREATE INDEX IF NOT EXISTS idx_capability_checks_time ON capability_checks (checked_at);
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

  /**
   * L'écran d'accueil à proposer, compte par compte (21/09/2026).
   *
   * Un marqueur par compte, sous son nom de session : allumé, l'accueil se propose à chaque
   * lancement de l'application ; seul le bouton de fin l'éteint — « Passer » ne fait que le cacher
   * jusqu'au prochain lancement, et une déconnexion en cours de route le laisse allumé.
   * L'administrateur le rallume depuis la gestion. Un compte sans ligne n'a rien à voir.
   *
   * Au départ, le seul compte de Louis : il a validé l'accueil avant de le proposer à tous. Depuis
   * le 21/09/2026, un compte absent de la table le voit (voir `onboardingDb.isPending`) ; une ligne
   * ne sert plus qu'à dire « fait » ou « à refaire ».
   */
  /* Les signalements (« Signaler un problème », 24/09/2026) : un ticket par signalement, ses
     échanges, ses images. Rien n'est jamais effacé — choix de l'administrateur. `draft` est un
     brouillon que seule la personne voit ; `*_seen_at` et `last_*_at` font la pastille de chaque
     côté (une réponse de l'administrateur que la personne n'a pas lue, et l'inverse). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT    NOT NULL,
      user_name      TEXT    NOT NULL,
      status         TEXT    NOT NULL DEFAULT 'open'
                     CHECK (status IN ('draft','open','in_progress','resolved','closed')),
      zone           TEXT    NOT NULL,
      element        TEXT,
      element_other  TEXT,
      issue          TEXT,
      issue_other    TEXT,
      item_id        TEXT,
      item_title     TEXT,
      item_kind      TEXT,
      description    TEXT    NOT NULL DEFAULT '',
      context        TEXT,
      logs           TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      sent_at        INTEGER,
      last_user_at   INTEGER NOT NULL,
      last_admin_at  INTEGER NOT NULL DEFAULT 0,
      user_seen_at   INTEGER NOT NULL,
      admin_seen_at  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_reports_user ON reports (user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, updated_at);

    CREATE TABLE IF NOT EXISTS report_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id   INTEGER NOT NULL,
      author      TEXT    NOT NULL CHECK (author IN ('user','admin','system')),
      author_name TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_messages ON report_messages (report_id, created_at);

    CREATE TABLE IF NOT EXISTS report_images (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id     INTEGER NOT NULL,
      message_id    INTEGER,
      file          TEXT,
      original      TEXT    NOT NULL,
      mime          TEXT    NOT NULL,
      original_name TEXT,
      width         INTEGER,
      height        INTEGER,
      bytes         INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_images ON report_images (report_id);
  `);
  // Le lien entre un ticket et la séance de lecture qu'il concerne, et qui l'a ouvert : l'auteur,
  // ou l'administrateur qui écrit à quelqu'un depuis une séance qui s'est mal passée (24/09/2026).
  try { db.exec("ALTER TABLE reports ADD COLUMN seance_id TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE reports ADD COLUMN opened_by TEXT NOT NULL DEFAULT 'user'"); } catch { /* already exists */ }
  db.exec("CREATE INDEX IF NOT EXISTS idx_reports_seance ON reports (seance_id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding (
      user_name  TEXT    PRIMARY KEY,
      pending    INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  if (!db.prepare("SELECT 1 FROM migrations_done WHERE name = 'onboarding-seed-louis'").get()) {
    const now = Date.now();
    db.prepare("INSERT OR IGNORE INTO onboarding (user_name, pending, updated_at) VALUES ('louis', 1, ?)").run(now);
    db.prepare("INSERT OR IGNORE INTO migrations_done (name, done_at) VALUES ('onboarding-seed-louis', ?)").run(now);
  }
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

/**
 * Une seule liste depuis le 21/09/2026. Le type reste, et la colonne aussi : la contrainte
 * `CHECK` de la table accepte encore les cinq anciennes valeurs, et la réécrire imposerait de
 * reconstruire la table pour rien — `migrate()` ramène tout à « to_watch » à chaque démarrage.
 */
export type WatchlistStatus = "to_watch";

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

  /**
   * Retirer un abonnement de ce compte-là seulement. `DELETE /api/push/subscribe` effaçait
   * l'adresse donnée quel qu'en soit le propriétaire : qui la connaissait coupait les
   * notifications d'un autre (26/09/2026).
   */
  removeForUser(userId: string, endpoint: string): void {
    getDb().prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
  },

  /**
   * Ne garder que les `keep` abonnements les plus récents du compte, `endpoint` (celui qu'on vient
   * d'enregistrer) toujours compris : le panneau Compte renvoie l'abonnement à chaque ouverture
   * sans en changer la date, et un appareil fidèle ne doit pas céder la place à des inconnus.
   */
  trimForUser(userId: string, keep: number, endpoint: string): void {
    getDb()
      .prepare(`
        DELETE FROM push_subscriptions
        WHERE user_id = ? AND endpoint != ? AND endpoint NOT IN (
          SELECT endpoint FROM push_subscriptions WHERE user_id = ? AND endpoint != ?
          ORDER BY created_at DESC, id DESC LIMIT ?
        )
      `)
      .run(userId, endpoint, userId, endpoint, Math.max(0, keep - 1));
  },

  /** Combien d'appareils reçoivent les notifications de ce compte (rangées sous son nom). */
  countForUser(userId: string): number {
    return (getDb().prepare("SELECT COUNT(*) as n FROM push_subscriptions WHERE user_id = ?").get(userId) as { n: number }).n;
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

/** Lignes effacées par tranche, et temps maximal passé à effacer par table et par passe. */
const CLEANUP_BATCH = 5_000;
const CLEANUP_BUDGET_MS = 250;

/** Le comportement d'un service sur une fenêtre de temps, agrégé par SQLite. */
export interface ServiceLatencyStat {
  service: string;
  samples: number;
  /** Null quand aucune mesure de la fenêtre n'a de latence — un service injoignable n'en a pas. */
  avgMs: number | null;
  maxMs: number | null;
  /** Nombre de relevés où le service n'était pas « ok ». */
  failures: number;
}

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

  /**
   * Ce que chaque service a coûté en temps de réponse sur une fenêtre, et ce qu'il a raté.
   *
   * `service_checks` était une table qu'on écrivait sans jamais la lire : une insertion, une
   * suppression, et pas un seul SELECT dans tout le dépôt — trois cent soixante mille mesures de
   * latence accumulées depuis des mois et jamais regardées. Ou bien on la supprimait, ou bien on
   * s'en servait ; la donnée était déjà là, et « quel service ralentit » est justement la question
   * qu'on se pose quand quelque chose traîne sans tomber.
   *
   * Une seule requête groupée, en un passage, servie par l'index sur la date : pas de tri, pas de
   * lignes remontées jusqu'à JavaScript.
   */
  getServiceLatencyStats(sinceMs: number): ServiceLatencyStat[] {
    return getDb()
      .prepare(
        `SELECT service,
                COUNT(*)                                        AS samples,
                CAST(ROUND(AVG(latency_ms)) AS INTEGER)         AS avgMs,
                MAX(latency_ms)                                 AS maxMs,
                SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS failures
         FROM service_checks
         WHERE checked_at >= ?
         GROUP BY service
         ORDER BY service ASC`
      )
      .all(sinceMs) as ServiceLatencyStat[];
  },

  /**
   * Le ménage, par tranches et sous budget de temps.
   *
   * En régime normal il n'y a qu'une heure de relevés à effacer — quelques milliers de lignes, une
   * seule tranche, rien à borner. Le cas qui compte est l'autre : un retard accumulé. Une rétention
   * qu'on raccourcit, une application arrêtée trois semaines, et la première passe se retrouve avec
   * un million de lignes à supprimer d'un seul coup. better-sqlite3 est synchrone : ce coup-là est
   * du temps pendant lequel plus rien n'est servi, ni une page ni un octet de film.
   *
   * Alors on efface par tranches jusqu'à épuisement *ou* jusqu'au budget, et ce qui reste attend la
   * passe suivante — elles se succèdent toutes les heures, personne n'est pressé. Le retard se
   * résorbe en quelques heures au lieu d'une seconde de gel.
   */
  cleanup(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    const db = getDb();
    for (const table of ["service_checks", "capability_checks"] as const) {
      // `rowid IN (… LIMIT n)` : SQLite n'accepte pas LIMIT sur un DELETE sans une option de
      // compilation que ce paquet n'active pas.
      const stmt = db.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE checked_at < ? LIMIT ${CLEANUP_BATCH})`
      );
      const startedAt = Date.now();
      for (;;) {
        const { changes } = stmt.run(cutoff);
        if (changes < CLEANUP_BATCH) break;
        if (Date.now() - startedAt > CLEANUP_BUDGET_MS) break;
      }
    }
  },
};

// ─── Session store ────────────────────────────────────────────────────────────

const SESSION_MAX_AGE_MS = 7 * 24 * 3600_000;

export interface StoredSession {
  jti: string;
  createdAt: number;
  lastSeenAt: number;
  /** « iPhone · Safari » ; `null` pour une session ouverte avant le 23/09/2026. */
  device: string | null;
}

/** Les migrations de données déjà passées, pour qu'elles ne repassent pas. */
export const onboardingDb = {
  isPending(userName: string): boolean {
    const row = getDb().prepare("SELECT pending FROM onboarding WHERE user_name = ?").get(userName) as { pending: number } | undefined;
    // Un compte sans ligne ne l'a jamais fait : il le voit. Depuis le 21/09/2026, où Louis l'a
    // ouvert à tous après l'avoir validé sur son compte — l'inverse ne le montrait qu'aux comptes
    // qu'on avait pensé à cocher, et à aucun compte Jellyfin créé ensuite.
    return row ? row.pending === 1 : true;
  },
  setPending(userName: string, pending: boolean): void {
    getDb()
      .prepare(`
        INSERT INTO onboarding (user_name, pending, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (user_name) DO UPDATE SET pending = excluded.pending, updated_at = excluded.updated_at
      `)
      .run(userName, pending ? 1 : 0, Date.now());
  },
  /** Le marqueur de chaque compte connu de la table. Un compte absent vaut « à faire » (voir isPending). */
  all(): Map<string, boolean> {
    const rows = getDb().prepare("SELECT user_name, pending FROM onboarding").all() as { user_name: string; pending: number }[];
    return new Map(rows.map((r) => [r.user_name, r.pending === 1]));
  },
};

export const migrationDb = {
  isDone(name: string): boolean {
    return !!getDb().prepare("SELECT 1 FROM migrations_done WHERE name = ?").get(name);
  },
  markDone(name: string): void {
    getDb().prepare("INSERT OR IGNORE INTO migrations_done (name, done_at) VALUES (?, ?)").run(name, Date.now());
  },
};

export const sessionDb = {
  /**
   * Ouvre une session. Rend les appareils Jellyfin des sessions expirées que ce passage a effacées,
   * pour que l'appelant révoque leurs jetons — personne ne s'en servira plus.
   */
  create(jti: string, userId: string, device: string | null = null, jfDevice: string | null = null): string[] {
    const db = getDb();
    const now = Date.now();
    db.prepare("INSERT OR REPLACE INTO sessions (jti, user_id, created_at, last_seen_at, device, jf_device) VALUES (?, ?, ?, ?, ?, ?)")
      .run(jti, userId, now, now, device, jfDevice);
    // Opportunistic cleanup of expired sessions
    const expired = db.prepare("SELECT jf_device FROM sessions WHERE last_seen_at < ? AND jf_device IS NOT NULL").all(now - SESSION_MAX_AGE_MS) as { jf_device: string }[];
    db.prepare("DELETE FROM sessions WHERE last_seen_at < ?").run(now - SESSION_MAX_AGE_MS);
    return expired.map((r) => r.jf_device);
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
      .prepare("SELECT jti, created_at, last_seen_at, device FROM sessions WHERE user_id = ? AND jti != ? ORDER BY last_seen_at DESC")
      .all(userId, currentJti) as { jti: string; created_at: number; last_seen_at: number; device: string | null }[];
    return rows.map((r) => ({ jti: r.jti, createdAt: r.created_at, lastSeenAt: r.last_seen_at, device: r.device ?? null }));
  },

  exists(jti: string): boolean {
    const db = getDb();
    return !!(db.prepare("SELECT 1 FROM sessions WHERE jti = ?").get(jti));
  },

  /** Ferme une session. Rend l'appareil Jellyfin qui lui était lié, s'il est connu. */
  delete(jti: string): string | null {
    const row = getDb().prepare("SELECT jf_device FROM sessions WHERE jti = ?").get(jti) as { jf_device: string | null } | undefined;
    getDb().prepare("DELETE FROM sessions WHERE jti = ?").run(jti);
    return row?.jf_device ?? null;
  },

  /** Toutes les sessions d'un compte, la plus récente d'abord — pour la page d'activité. */
  listForUser(userId: string): StoredSession[] {
    const rows = getDb()
      .prepare("SELECT jti, created_at, last_seen_at, device FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC")
      .all(userId) as { jti: string; created_at: number; last_seen_at: number; device: string | null }[];
    return rows.map((r) => ({ jti: r.jti, createdAt: r.created_at, lastSeenAt: r.last_seen_at, device: r.device ?? null }));
  },

  /** Combien de sessions, et vue quand pour la dernière fois, par compte. */
  summaryByUser(): Map<string, { count: number; lastSeenAt: number }> {
    const rows = getDb()
      .prepare("SELECT user_id, COUNT(*) as n, MAX(last_seen_at) as seen FROM sessions GROUP BY user_id")
      .all() as { user_id: string; n: number; seen: number }[];
    return new Map(rows.map((r) => [r.user_id, { count: r.n, lastSeenAt: r.seen }]));
  },

  /** Fermer toutes les sessions d'un compte. Rend les `jti` fermés. */
  deleteForUser(userId: string): { jti: string; jfDevice: string | null }[] {
    const rows = getDb().prepare("SELECT jti, jf_device FROM sessions WHERE user_id = ?").all(userId) as { jti: string; jf_device: string | null }[];
    getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    return rows.map((r) => ({ jti: r.jti, jfDevice: r.jf_device }));
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


/**
 * Le mode maintenance, tel que l'administrateur l'a laissé.
 *
 * Deux choses distinctes, et elles ne s'éteignent pas ensemble : un état affiché tant qu'il dure
 * — le bandeau —, et un avis ponctuel daté — la fenêtre sur les lecteurs en cours. Ranger les deux
 * dans un seul booléen rendrait impossible d'avertir deux fois, ou d'avertir sans avoir d'abord
 * allumé le bandeau.
 */
/**
 * Combien de temps le bandeau tient sans qu'on le retouche.
 *
 * Un redéploiement dure des minutes ; cette durée est donc large, et elle n'est pas là pour
 * mesurer une maintenance mais pour rattraper un oubli. Le vrai risque n'est pas de l'éteindre
 * trop tôt, c'est qu'il reste des semaines sur les écrans de dix-neuf personnes parce que personne
 * n'a rouvert le panneau qui l'a allumé.
 */
const MAINTENANCE_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * Combien de temps un avis de redémarrage reste un avis.
 *
 * « L'application va redémarrer » ne veut rien dire une heure après : le redémarrage a eu lieu, ou
 * il n'aura pas lieu. Sans cette borne, l'avis dormait dans la base et sautait au visage du
 * premier écran qui lançait une lecture — un autre compte, un autre appareil, un navigateur au
 * stockage vide — longtemps après que tout soit fini.
 *
 * Deux minutes : de quoi couvrir le sondage des écrans, qui est de quinze secondes, et quelqu'un
 * qui lance un film à l'instant où l'on appuie. Au-delà, ce n'est plus un avertissement, c'est une
 * embuscade.
 */
const MAINTENANCE_NOTICE_FRESH_MS = 2 * 60 * 1000;

export interface MaintenanceState {
  active: boolean;
  /** Date du dernier avis de redémarrage imminent, en ms, ou null s'il n'y en a jamais eu. */
  noticeAt: number | null;
  /** Quand le bandeau s'éteindra tout seul, en ms. Null quand il est éteint. */
  expiresAt: number | null;
}

// ─── Signalements ───────────────────────────────────────────────────────────────

export type ReportStatus = "draft" | "open" | "in_progress" | "resolved" | "closed";

export interface ReportRow {
  id: number;
  userId: string;
  userName: string;
  status: ReportStatus;
  zone: string;
  element: string | null;
  elementOther: string | null;
  issue: string | null;
  issueOther: string | null;
  itemId: string | null;
  itemTitle: string | null;
  itemKind: string | null;
  description: string;
  context: Record<string, unknown> | null;
  logs: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  lastUserAt: number;
  lastAdminAt: number;
  userSeenAt: number;
  adminSeenAt: number;
  /** La séance de lecture que ce ticket concerne, quand on la connaît. */
  seanceId: string | null;
  /** « admin » : ouvert par l'administrateur pour cette personne, depuis une séance. */
  openedBy: "user" | "admin";
}

export interface ReportMessage {
  id: number;
  reportId: number;
  author: "user" | "admin" | "system";
  authorName: string;
  body: string;
  createdAt: number;
}

export interface ReportImage {
  id: number;
  reportId: number;
  messageId: number | null;
  file: string | null;
  original: string;
  mime: string;
  originalName: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  createdAt: number;
}

type ReportDbRow = {
  id: number; user_id: string; user_name: string; status: ReportStatus; zone: string; element: string | null;
  element_other: string | null; issue: string | null; issue_other: string | null; item_id: string | null;
  item_title: string | null; item_kind: string | null; description: string; context: string | null; logs: string | null;
  created_at: number; updated_at: number; sent_at: number | null; last_user_at: number; last_admin_at: number;
  user_seen_at: number; admin_seen_at: number; seance_id: string | null; opened_by: string;
};

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toReport(r: ReportDbRow): ReportRow {
  return {
    id: r.id, userId: r.user_id, userName: r.user_name, status: r.status, zone: r.zone, element: r.element,
    elementOther: r.element_other, issue: r.issue, issueOther: r.issue_other, itemId: r.item_id, itemTitle: r.item_title,
    itemKind: r.item_kind, description: r.description, context: parseJson(r.context), logs: parseJson(r.logs),
    createdAt: r.created_at, updatedAt: r.updated_at, sentAt: r.sent_at, lastUserAt: r.last_user_at,
    lastAdminAt: r.last_admin_at, userSeenAt: r.user_seen_at, adminSeenAt: r.admin_seen_at,
    seanceId: r.seance_id, openedBy: r.opened_by === "admin" ? "admin" : "user",
  };
}

export interface ReportFields {
  zone: string;
  element: string | null;
  elementOther: string | null;
  issue: string | null;
  issueOther: string | null;
  itemId: string | null;
  itemTitle: string | null;
  itemKind: string | null;
  description: string;
}

export const reportsDb = {
  create(userId: string, userName: string, fields: ReportFields, draft: boolean, context: unknown): ReportRow {
    const now = Date.now();
    const info = getDb()
      .prepare(`INSERT INTO reports (user_id, user_name, status, zone, element, element_other, issue, issue_other, item_id,
        item_title, item_kind, description, context, created_at, updated_at, sent_at, last_user_at, user_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, userName, draft ? "draft" : "open", fields.zone, fields.element, fields.elementOther, fields.issue,
        fields.issueOther, fields.itemId, fields.itemTitle, fields.itemKind, fields.description, JSON.stringify(context ?? null),
        now, now, draft ? null : now, now, now);
    return reportsDb.get(Number(info.lastInsertRowid))!;
  },

  /** Un brouillon réécrit : ses choix et son texte, rien d'autre. */
  updateDraft(id: number, fields: ReportFields, context: unknown): void {
    getDb()
      .prepare(`UPDATE reports SET zone = ?, element = ?, element_other = ?, issue = ?, issue_other = ?, item_id = ?,
        item_title = ?, item_kind = ?, description = ?, context = ?, updated_at = ?, last_user_at = ? WHERE id = ? AND status = 'draft'`)
      .run(fields.zone, fields.element, fields.elementOther, fields.issue, fields.issueOther, fields.itemId, fields.itemTitle,
        fields.itemKind, fields.description, JSON.stringify(context ?? null), Date.now(), Date.now(), id);
  },

  /** Le brouillon part : il devient un signalement ouvert, avec ses journaux figés. */
  /**
   * Vrai si c'est cet appel qui l'a fait partir. Deux envois simultanés du même brouillon passaient
   * tous deux la vérification d'avant la lecture du formulaire : le second ne change plus rien et le
   * dit, pour ne pas prévenir l'administrateur une seconde fois (relu le 24/09/2026).
   */
  send(id: number, logs: unknown): boolean {
    const now = Date.now();
    return (
      getDb()
        .prepare("UPDATE reports SET status = 'open', sent_at = ?, logs = ?, updated_at = ?, last_user_at = ? WHERE id = ? AND status = 'draft'")
        .run(now, JSON.stringify(logs ?? null), now, now, id).changes > 0
    );
  },

  /** Supprimer un brouillon et tout ce qu'il porte. Un signalement envoyé, lui, ne s'efface pas. */
  deleteDraft(id: number): boolean {
    const db = getDb();
    return db.transaction(() => {
      const removed = db.prepare("DELETE FROM reports WHERE id = ? AND status = 'draft'").run(id).changes > 0;
      if (removed) {
        db.prepare("DELETE FROM report_images WHERE report_id = ?").run(id);
        db.prepare("DELETE FROM report_messages WHERE report_id = ?").run(id);
      }
      return removed;
    })();
  },

  setSeance(id: number, seanceId: string | null): void {
    getDb().prepare("UPDATE reports SET seance_id = ? WHERE id = ?").run(seanceId, id);
  },

  /** Les tickets qui citent une séance — pour la montrer depuis la séance. */
  forSeance(seanceId: string): ReportRow[] {
    return (getDb().prepare("SELECT * FROM reports WHERE seance_id = ? AND status != 'draft' ORDER BY created_at").all(seanceId) as ReportDbRow[]).map(toReport);
  },

  /**
   * Un ticket ouvert par l'administrateur pour quelqu'un : il appartient à cette personne — c'est
   * dans « Mes signalements » qu'elle le lit et y répond —, et c'est elle qui a du nouveau.
   */
  openForUser(userId: string, userName: string, fields: ReportFields, seanceId: string | null, logs: unknown): ReportRow {
    const now = Date.now();
    const info = getDb()
      .prepare(`INSERT INTO reports (user_id, user_name, status, zone, element, element_other, issue, issue_other, item_id,
        item_title, item_kind, description, context, logs, created_at, updated_at, sent_at, last_user_at, last_admin_at,
        user_seen_at, admin_seen_at, seance_id, opened_by)
        VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'admin')`)
      .run(userId, userName, fields.zone, fields.element, fields.elementOther, fields.issue, fields.issueOther, fields.itemId,
        fields.itemTitle, fields.itemKind, fields.description, JSON.stringify(logs ?? null), now, now, now, now, now, seanceId);
    return reportsDb.get(Number(info.lastInsertRowid))!;
  },

  setLogs(id: number, logs: unknown): void {
    getDb().prepare("UPDATE reports SET logs = ? WHERE id = ?").run(JSON.stringify(logs ?? null), id);
  },

  get(id: number): ReportRow | null {
    const row = getDb().prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportDbRow | undefined;
    return row ? toReport(row) : null;
  },

  /** Pour le plafond par compte (`reportQuota`) : créés depuis `sinceMs`, et brouillons encore ouverts. */
  quotaCounts(userId: string, sinceMs: number): { created: number; drafts: number } {
    const row = getDb()
      .prepare("SELECT SUM(created_at >= ?) AS created, SUM(status = 'draft') AS drafts FROM reports WHERE user_id = ?")
      .get(sinceMs, userId) as { created: number | null; drafts: number | null };
    return { created: row.created ?? 0, drafts: row.drafts ?? 0 };
  },

  listForUser(userId: string): ReportRow[] {
    return (getDb().prepare("SELECT * FROM reports WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as ReportDbRow[]).map(toReport);
  },

  /** Pour l'administrateur : tout sauf les brouillons, que personne d'autre que leur auteur ne voit. */
  listSent(): ReportRow[] {
    return (getDb().prepare("SELECT * FROM reports WHERE status != 'draft' ORDER BY updated_at DESC").all() as ReportDbRow[]).map(toReport);
  },

  /**
   * `quiet` : un changement dont l'autre côté n'a pas à être averti — une fermeture. Il s'inscrit
   * dans le fil, mais n'allume aucune pastille (demandé le 24/09/2026).
   */
  setStatus(id: number, status: ReportStatus, by: "user" | "admin", quiet = false): void {
    const now = Date.now();
    if (quiet) {
      getDb().prepare("UPDATE reports SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
      return;
    }
    getDb()
      .prepare(`UPDATE reports SET status = ?, updated_at = ?, ${by === "admin" ? "last_admin_at" : "last_user_at"} = ? WHERE id = ?`)
      .run(status, now, now, id);
  },

  addMessage(reportId: number, author: ReportMessage["author"], authorName: string, body: string): ReportMessage {
    const now = Date.now();
    const info = getDb()
      .prepare("INSERT INTO report_messages (report_id, author, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(reportId, author, authorName, body, now);
    if (author !== "system") {
      getDb()
        .prepare(`UPDATE reports SET updated_at = ?, ${author === "admin" ? "last_admin_at" : "last_user_at"} = ? WHERE id = ?`)
        .run(now, now, reportId);
    }
    return { id: Number(info.lastInsertRowid), reportId, author, authorName, body, createdAt: now };
  },

  messages(reportId: number): ReportMessage[] {
    const rows = getDb().prepare("SELECT * FROM report_messages WHERE report_id = ? ORDER BY created_at, id").all(reportId) as {
      id: number; report_id: number; author: ReportMessage["author"]; author_name: string; body: string; created_at: number;
    }[];
    return rows.map((r) => ({ id: r.id, reportId: r.report_id, author: r.author, authorName: r.author_name, body: r.body, createdAt: r.created_at }));
  },

  addImage(image: Omit<ReportImage, "id" | "createdAt">): ReportImage {
    const now = Date.now();
    const info = getDb()
      .prepare(`INSERT INTO report_images (report_id, message_id, file, original, mime, original_name, width, height, bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(image.reportId, image.messageId, image.file, image.original, image.mime, image.originalName, image.width, image.height, image.bytes, now);
    return { ...image, id: Number(info.lastInsertRowid), createdAt: now };
  },

  images(reportId: number): ReportImage[] {
    const rows = getDb().prepare("SELECT * FROM report_images WHERE report_id = ? ORDER BY id").all(reportId) as {
      id: number; report_id: number; message_id: number | null; file: string | null; original: string; mime: string;
      original_name: string | null; width: number | null; height: number | null; bytes: number; created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id, reportId: r.report_id, messageId: r.message_id, file: r.file, original: r.original, mime: r.mime,
      originalName: r.original_name, width: r.width, height: r.height, bytes: r.bytes, createdAt: r.created_at,
    }));
  },

  /** Retirer une image d'un brouillon — un signalement envoyé, lui, garde tout. */
  removeDraftImage(reportId: number, imageId: number): ReportImage | null {
    const report = reportsDb.get(reportId);
    if (!report || report.status !== "draft") return null;
    const image = reportsDb.images(reportId).find((i) => i.id === imageId) ?? null;
    if (image) getDb().prepare("DELETE FROM report_images WHERE id = ? AND report_id = ?").run(imageId, reportId);
    return image;
  },

  markSeen(id: number, by: "user" | "admin"): void {
    getDb().prepare(`UPDATE reports SET ${by === "admin" ? "admin_seen_at" : "user_seen_at"} = ? WHERE id = ?`).run(Date.now(), id);
  },

  /** Des réponses de l'administrateur que cette personne n'a pas encore lues. */
  unreadForUser(userId: string): number {
    return (getDb().prepare("SELECT COUNT(*) as n FROM reports WHERE user_id = ? AND status != 'draft' AND last_admin_at > user_seen_at").get(userId) as { n: number }).n;
  },

  /** Des signalements ou des commentaires que l'administrateur n'a pas encore lus. */
  unreadForAdmin(): number {
    return (getDb().prepare("SELECT COUNT(*) as n FROM reports WHERE status != 'draft' AND last_user_at > admin_seen_at").get() as { n: number }).n;
  },
};

export const maintenanceDb = {
  /**
   * L'état, avec l'expiration évaluée **à la lecture**.
   *
   * Et non par un minuteur : le seul moment où ce drapeau sert est celui où le conteneur est
   * recréé, donc un minuteur mourrait précisément quand il aurait dû compter. Une date en base
   * comparée à l'heure courante survit à tout, y compris à un serveur éteint une nuit entière.
   *
   * La ligne n'est pas réécrite en passant : une lecture ne doit pas écrire — plusieurs écrans
   * sondent cette route toutes les quinze secondes, et la base est synchrone. La date périmée
   * reste donc en place, inoffensive, jusqu'au prochain allumage.
   */
  get(now = Date.now()): MaintenanceState {
    const row = getDb().prepare("SELECT active, notice_at, expires_at FROM maintenance WHERE id = 1").get() as
      | { active: number; notice_at: number | null; expires_at: number | null }
      | undefined;
    // Jamais écrit : l'installation n'est pas en maintenance, ce qui est le bon défaut.
    const expired = row?.expires_at != null && row.expires_at <= now;
    const active = !!row?.active && !expired;
    // L'avis se périme lui aussi, et bien plus vite que le bandeau : il annonce un instant, pas un
    // état. Passé sa fenêtre, il n'est plus servi du tout — aucun écran ne peut donc le découvrir
    // en retard, quel que soit ce qu'il a déjà vu de son côté.
    const notice = row?.notice_at ?? null;
    const noticeAt = notice !== null && now - notice <= MAINTENANCE_NOTICE_FRESH_MS ? notice : null;
    return { active, noticeAt, expiresAt: active ? row?.expires_at ?? null : null };
  },

  /** Allumer pose l'échéance ; éteindre l'efface, pour qu'un rallumage reparte d'un compte plein. */
  setActive(active: boolean, now = Date.now()): MaintenanceState {
    getDb()
      .prepare(
        `INSERT INTO maintenance (id, active, notice_at, expires_at) VALUES (1, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET active = excluded.active, expires_at = excluded.expires_at`
      )
      .run(active ? 1 : 0, active ? now + MAINTENANCE_MAX_MS : null);
    return maintenanceDb.get(now);
  },

  /**
   * Lève un avis de redémarrage imminent, daté de maintenant.
   *
   * Ne touche pas à `active` : prévenir et afficher un bandeau sont deux gestes, et l'un peut
   * précéder l'autre. Renvoie l'état complet pour que l'appelant n'ait pas à relire.
   */
  raiseNotice(at = Date.now()): MaintenanceState {
    getDb()
      .prepare(
        `INSERT INTO maintenance (id, active, notice_at, expires_at) VALUES (1, 0, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET notice_at = excluded.notice_at`
      )
      .run(at);
    return maintenanceDb.get();
  },
};


/**
 * La mémoire du palmarès du jour — voir `Top10Memory` dans `cinemaRails`.
 *
 * Deux lignes par jour au plus, une par collection, et rien à faire vieillir : sept octets de
 * texte par journée passée, soit quelques kilo-octets par décennie. Les purger coûterait plus
 * cher à écrire qu'à garder, et l'historique sert — c'est lui qui empêche un film de tenir
 * l'affiche plus de trois jours d'affilée.
 */
export const dailyTop10Db = {
  recall(kind: string, day: string): Top10Theme | null | undefined {
    const row = getDb().prepare("SELECT theme FROM daily_top10 WHERE kind = ? AND day = ?").get(kind, day) as
      | { theme: string }
      | undefined;
    if (!row) return undefined;
    if (row.theme === "") return null;
    try {
      return JSON.parse(row.theme) as Top10Theme;
    } catch {
      // Une ligne illisible vaut mieux oubliée que crue : on retombe sur le tirage, qui est juste.
      return undefined;
    }
  },

  remember(kind: string, day: string, theme: Top10Theme | null): void {
    // `DO NOTHING` et non `DO UPDATE` : le premier à répondre aujourd'hui a raison, et deux
    // requêtes arrivées ensemble ne doivent pas se contredire. C'est tout l'objet de cette table.
    getDb()
      .prepare("INSERT INTO daily_top10 (kind, day, theme) VALUES (?, ?, ?) ON CONFLICT(kind, day) DO NOTHING")
      .run(kind, day, theme === null ? "" : JSON.stringify(theme));
  },

  /** Ce que les routes passent à `dailyTop10`, déjà lié à leur collection. */
  forKind(kind: "movies" | "series"): Top10Memory {
    return {
      recall: (day) => dailyTop10Db.recall(kind, day),
      remember: (day, theme) => dailyTop10Db.remember(kind, day, theme),
    };
  },
};

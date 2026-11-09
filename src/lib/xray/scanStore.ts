import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import type { PlannedItem, ScanTier } from "./scanPlan";

/**
 * Ce que Laterna retient des analyses d'acteurs (DECISIONS.md §138), dans `cine.db` — trois tables
 * créées ici, à la première utilisation (`CREATE TABLE IF NOT EXISTS`, idempotent : un redémarrage, ou
 * deux copies du module, ne recréent rien) :
 *
 * - `xray_file_versions` : pour chaque élément et chaque `ETag` commandé, la durée que Jellyfin donnait
 *   alors. C'est elle qui dit qu'un fichier remplacé **à durée égale** (± 1 s) — un réencodage, les 65
 *   épisodes de *MacGyver* passés d'AV1 à HEVC le 09/11/2026 — garde son analyse : ses temps tombent
 *   toujours juste. Écrite par toute commande, celle du lecteur (`orders.ts`) comme celle du fond.
 * - `xray_scan_items` : le plan du fond (`scheduler.ts`) — un élément par ligne, son palier, son rang,
 *   son état (`pending`, `queued`, `done`, `failed`, `excluded`), l'`ETag` analysé, et, une fois fini,
 *   le temps de calcul que le service a mesuré (la vitesse de l'estimation).
 * - `xray_scan_meta` : les gestes de l'administrateur (pause et forçage par palier) et les dates des
 *   relectures du plan — ce qui doit survivre à un redémarrage.
 *
 * Toutes les requêtes sont synchrones (CLAUDE.md) : les écritures du plan se font par tranches de
 * 500 lignes dans une transaction, la boucle rendue entre deux (`replacePlan` est appelé par tranches).
 */

const ready = new WeakSet<Database.Database>();

function db(): Database.Database {
  const d = getDb();
  if (!ready.has(d)) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS xray_file_versions (
        item_id TEXT NOT NULL,
        etag TEXT NOT NULL,
        duration_s REAL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, etag)
      );
      CREATE TABLE IF NOT EXISTS xray_scan_items (
        item_id TEXT PRIMARY KEY,
        tier INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        series_id TEXT,
        duration_s REAL NOT NULL DEFAULT 0,
        imported_at INTEGER NOT NULL DEFAULT 0,
        rank INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        etag TEXT,
        error TEXT,
        compute_s REAL,
        ordered_at INTEGER,
        finished_at INTEGER,
        checked_at INTEGER,
        plan_seen INTEGER NOT NULL DEFAULT 0,
        priority_of TEXT
      );
      CREATE INDEX IF NOT EXISTS xray_scan_items_next ON xray_scan_items (status, tier, rank);
      CREATE TABLE IF NOT EXISTS xray_scan_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    ready.add(d);
  }
  return d;
}

// ─── Les versions de fichier ─────────────────────────────────────────────────

export function recordFileVersion(itemId: string, etag: string, durationS: number | null, now = Date.now()): void {
  if (!etag) return;
  db()
    .prepare(
      `INSERT INTO xray_file_versions (item_id, etag, duration_s, recorded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id, etag) DO UPDATE SET duration_s = COALESCE(excluded.duration_s, duration_s), recorded_at = excluded.recorded_at`,
    )
    .run(itemId.toLowerCase(), etag, durationS && durationS > 0 ? durationS : null, now);
}

/** La durée retenue pour cette version du fichier, ou `null` si elle n'a jamais été commandée d'ici. */
export function recordedDuration(itemId: string, etag: string): number | null {
  const row = db().prepare("SELECT duration_s AS d FROM xray_file_versions WHERE item_id = ? AND etag = ?").get(itemId.toLowerCase(), etag) as { d: number | null } | undefined;
  return row?.d ?? null;
}

// ─── Le plan ─────────────────────────────────────────────────────────────────

export type ScanStatus = "pending" | "queued" | "done" | "failed" | "excluded";

export interface ScanRow {
  itemId: string;
  tier: ScanTier;
  kind: "Movie" | "Episode";
  title: string;
  seriesId: string | null;
  durationS: number;
  importedAt: number;
  rank: number;
  status: ScanStatus;
  reason: string | null;
  etag: string | null;
  error: string | null;
  computeS: number | null;
  orderedAt: number | null;
  finishedAt: number | null;
  checkedAt: number | null;
}

const COLUMNS = `item_id AS itemId, tier, kind, title, series_id AS seriesId, duration_s AS durationS, imported_at AS importedAt, rank,
  status, reason, etag, error, compute_s AS computeS, ordered_at AS orderedAt, finished_at AS finishedAt, checked_at AS checkedAt`;

/**
 * Une tranche du plan : chaque élément est inséré ou mis à jour (palier, rang, durée, date), son état
 * gardé — sauf si sa date d'import a changé (un fichier nouveau au même élément) : il repasse à vérifier.
 * Un élément écarté pour l'animation le reste tant que son genre ne change pas ; le genre retiré, il
 * repasse à vérifier. Un élément de la liste de priorité (palier 0) y reste. `generation` marque les lignes vues par cette relecture (`dropUnseen`).
 */
export function upsertPlanSlice(items: readonly PlannedItem[], generation: number): void {
  const d = db();
  const insert = d.prepare(
    `INSERT INTO xray_scan_items (item_id, tier, kind, title, series_id, duration_s, imported_at, rank, status, reason, plan_seen)
     VALUES (@itemId, @tier, @kind, @title, @seriesId, @durationS, @importedAt, @rank, @status, @reason, @generation)
     ON CONFLICT(item_id) DO UPDATE SET
       tier = CASE WHEN xray_scan_items.tier = 0 THEN 0 ELSE excluded.tier END,
       kind = excluded.kind, title = excluded.title, series_id = excluded.series_id, duration_s = excluded.duration_s,
       rank = CASE WHEN xray_scan_items.tier = 0 THEN xray_scan_items.rank ELSE excluded.rank END,
       plan_seen = excluded.plan_seen,
       status = CASE
         WHEN excluded.status = 'excluded' AND xray_scan_items.status IN ('pending', 'failed') THEN 'excluded'
         WHEN excluded.status = 'excluded' THEN xray_scan_items.status
         WHEN xray_scan_items.status = 'excluded' AND xray_scan_items.reason = 'animation' THEN 'pending'
         WHEN xray_scan_items.imported_at <> excluded.imported_at AND xray_scan_items.status IN ('done', 'failed', 'excluded') THEN 'pending'
         ELSE xray_scan_items.status END,
       reason = CASE
         WHEN excluded.status = 'excluded' AND xray_scan_items.status IN ('pending', 'failed') THEN excluded.reason
         WHEN xray_scan_items.status = 'excluded' AND xray_scan_items.reason = 'animation' AND excluded.status <> 'excluded' THEN NULL
         ELSE xray_scan_items.reason END,
       imported_at = excluded.imported_at`,
  );
  d.transaction(() => {
    for (const item of items) {
      insert.run({
        itemId: item.itemId.toLowerCase(),
        tier: item.tier,
        kind: item.kind,
        title: item.title.slice(0, 200),
        seriesId: item.seriesId,
        durationS: item.durationS,
        importedAt: Math.round(item.importedAt),
        rank: item.rank,
        status: item.excluded ? "excluded" : "pending",
        reason: item.excluded,
        generation,
      });
    }
  })();
}

/** Les éléments que cette relecture n'a pas vus — partis de la bibliothèque — sont oubliés. */
export function dropUnseen(generation: number): number {
  return db().prepare("DELETE FROM xray_scan_items WHERE plan_seen <> ?").run(generation).changes;
}

/**
 * Le palier 1 relu seul (toutes les dix minutes) : ce qui y entre y passe, ce qui en sort retrouve le
 * palier de sa date (2 dans la fenêtre des arrivées, 3 sinon). Les éléments que le plan ne connaît pas
 * encore attendent la relecture complète.
 */
export function setWatching(ranks: Map<string, number>, newSince: number): void {
  const d = db();
  d.transaction(() => {
    d.prepare("UPDATE xray_scan_items SET tier = CASE WHEN imported_at >= ? THEN 2 ELSE 3 END WHERE tier = 1").run(newSince);
    // La liste de priorité (palier 0) passe avant : un élément qui y est n'en descend pas.
    const one = d.prepare("UPDATE xray_scan_items SET tier = 1, rank = ? WHERE item_id = ? AND tier <> 0");
    for (const [id, rank] of ranks) one.run(rank, id.toLowerCase());
  })();
  // Les paliers 2 et 3 se lisent par date (`nextPending`) : le rang n'y sert pas.
}

export function planSize(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM xray_scan_items").get() as { n: number }).n;
}

export function rowsWithStatus(status: ScanStatus, limit = 50): ScanRow[] {
  return db().prepare(`SELECT ${COLUMNS} FROM xray_scan_items WHERE status = ? ORDER BY ordered_at LIMIT ?`).all(status, limit) as ScanRow[];
}

/** Les prochains à vérifier, palier par palier — le 0 et le 1 par rang, les autres du plus récent au plus ancien. */
export function nextPending(tiers: readonly ScanTier[], limit: number): ScanRow[] {
  if (tiers.length === 0) return [];
  const marks = tiers.map(() => "?").join(",");
  return db()
    .prepare(`SELECT ${COLUMNS} FROM xray_scan_items WHERE status = 'pending' AND tier IN (${marks}) ORDER BY tier, CASE WHEN tier <= 1 THEN rank ELSE -imported_at END, item_id LIMIT ?`)
    .all(...tiers, limit) as ScanRow[];
}

/** Les éléments finis dont l'`ETag` n'a pas été relu depuis `before` — la relecture lente. */
export function staleDone(before: number, limit: number): ScanRow[] {
  return db()
    .prepare(`SELECT ${COLUMNS} FROM xray_scan_items WHERE status IN ('done', 'failed') AND COALESCE(checked_at, 0) < ? ORDER BY COALESCE(checked_at, 0) LIMIT ?`)
    .all(before, limit) as ScanRow[];
}

export function getRow(itemId: string): ScanRow | null {
  return (db().prepare(`SELECT ${COLUMNS} FROM xray_scan_items WHERE item_id = ?`).get(itemId.toLowerCase()) as ScanRow | undefined) ?? null;
}

export function markRow(
  itemId: string,
  fields: Partial<Pick<ScanRow, "status" | "reason" | "etag" | "error" | "computeS" | "orderedAt" | "finishedAt" | "checkedAt">>,
): void {
  const map: Record<string, string> = {
    status: "status",
    reason: "reason",
    etag: "etag",
    error: "error",
    computeS: "compute_s",
    orderedAt: "ordered_at",
    finishedAt: "finished_at",
    checkedAt: "checked_at",
  };
  const keys = Object.keys(fields).filter((k) => k in map);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${map[k]} = @${k}`).join(", ");
  db()
    .prepare(`UPDATE xray_scan_items SET ${sets} WHERE item_id = @itemId`)
    .run({ ...Object.fromEntries(keys.map((k) => [k, (fields as Record<string, unknown>)[k] ?? null])), itemId: itemId.toLowerCase() });
}

export interface TierCounts {
  tier: ScanTier;
  total: number;
  done: number;
  queued: number;
  failed: number;
  excluded: number;
  hoursTotal: number;
  hoursDone: number;
  /** Secondes de vidéo qui restent (ni finies, ni écartées, ni en échec). */
  remainingS: number;
}

/** Les compteurs par palier. `total` ne compte pas les écartés, qui ne seront jamais analysés. */
export function tierCounts(): TierCounts[] {
  const rows = db()
    .prepare("SELECT tier, status, COUNT(*) AS n, COALESCE(SUM(duration_s), 0) AS s FROM xray_scan_items GROUP BY tier, status")
    .all() as { tier: ScanTier; status: ScanStatus; n: number; s: number }[];
  return ([0, 1, 2, 3] as const).map((tier) => {
    const of = (status: ScanStatus) => rows.find((r) => r.tier === tier && r.status === status) ?? { n: 0, s: 0 };
    const done = of("done");
    const queued = of("queued");
    const failed = of("failed");
    const pending = of("pending");
    const excluded = of("excluded");
    return {
      tier,
      total: done.n + queued.n + failed.n + pending.n,
      done: done.n,
      queued: queued.n,
      failed: failed.n,
      excluded: excluded.n,
      hoursTotal: (done.s + queued.s + failed.s + pending.s) / 3600,
      hoursDone: done.s / 3600,
      remainingS: queued.s + pending.s,
    };
  });
}

/** Les derniers éléments finis par le fond, avec leur temps de calcul — la base de la vitesse. */
export function speedSamples(limit = 30): { durationS: number; computeS: number }[] {
  return db()
    .prepare("SELECT duration_s AS durationS, compute_s AS computeS FROM xray_scan_items WHERE status = 'done' AND compute_s > 0 ORDER BY finished_at DESC LIMIT ?")
    .all(limit) as { durationS: number; computeS: number }[];
}

export function lastErrors(limit = 10): { itemId: string; title: string; error: string; at: number }[] {
  return db()
    .prepare("SELECT item_id AS itemId, title, COALESCE(error, '') AS error, COALESCE(finished_at, checked_at, 0) AS at FROM xray_scan_items WHERE status = 'failed' ORDER BY at DESC LIMIT ?")
    .all(limit) as { itemId: string; title: string; error: string; at: number }[];
}

// ─── La liste de priorité ────────────────────────────────────────────────────

export interface PriorityRow {
  itemId: string;
  kind: "Movie" | "Episode";
  title: string;
  seriesId: string | null;
  durationS: number;
}

/**
 * Les éléments d'un titre de la liste de priorité passent au palier 0, dans l'ordre donné, à partir de
 * `baseRank` ; un élément que le plan n'a pas encore lu est ajouté (il attend d'être vérifié). Son état
 * est gardé : un élément déjà fait le reste.
 */
export function setPriorityRows(entryId: string, rows: readonly PriorityRow[], baseRank: number): void {
  const d = db();
  const upsert = d.prepare(
    `INSERT INTO xray_scan_items (item_id, tier, kind, title, series_id, duration_s, rank, status, priority_of)
     VALUES (@itemId, 0, @kind, @title, @seriesId, @durationS, @rank, 'pending', @entryId)
     ON CONFLICT(item_id) DO UPDATE SET tier = 0, rank = excluded.rank, priority_of = excluded.priority_of,
       -- Une commande « low » du fond déjà en file est revue : la prochaine la remonte en « normal ».
       status = CASE WHEN xray_scan_items.status = 'queued' AND xray_scan_items.tier <> 0 THEN 'pending' ELSE xray_scan_items.status END,
       duration_s = CASE WHEN excluded.duration_s > 0 THEN excluded.duration_s ELSE xray_scan_items.duration_s END`,
  );
  d.transaction(() => {
    rows.forEach((row, i) =>
      upsert.run({
        itemId: row.itemId.toLowerCase(),
        kind: row.kind,
        title: row.title.slice(0, 200),
        seriesId: row.seriesId,
        durationS: row.durationS,
        rank: baseRank + i,
        entryId: entryId.toLowerCase(),
      }),
    );
  })();
}

/** Un titre retiré de la liste : ses éléments retrouvent le palier de leur date (le 1 à la relecture suivante). */
export function clearPriorityRows(entryId: string, newSince: number): number {
  return db()
    .prepare("UPDATE xray_scan_items SET tier = CASE WHEN imported_at >= ? THEN 2 ELSE 3 END, priority_of = NULL WHERE priority_of = ?")
    .run(newSince, entryId.toLowerCase()).changes;
}

export interface PriorityCounts {
  entryId: string;
  total: number;
  done: number;
  queued: number;
  failed: number;
  excluded: number;
  remainingS: number;
}

/** L'avancement de chaque titre de la liste de priorité. `total` sans les écartés, comme les paliers. */
export function priorityCounts(): Map<string, PriorityCounts> {
  const rows = db()
    .prepare("SELECT priority_of AS entryId, status, COUNT(*) AS n, COALESCE(SUM(duration_s), 0) AS s FROM xray_scan_items WHERE priority_of IS NOT NULL GROUP BY priority_of, status")
    .all() as { entryId: string; status: ScanStatus; n: number; s: number }[];
  const out = new Map<string, PriorityCounts>();
  for (const r of rows) {
    const c = out.get(r.entryId) ?? { entryId: r.entryId, total: 0, done: 0, queued: 0, failed: 0, excluded: 0, remainingS: 0 };
    if (r.status === "excluded") c.excluded += r.n;
    else c.total += r.n;
    if (r.status === "done") c.done += r.n;
    if (r.status === "queued") c.queued += r.n;
    if (r.status === "failed") c.failed += r.n;
    if (r.status === "queued" || r.status === "pending") c.remainingS += r.s;
    out.set(r.entryId, c);
  }
  return out;
}

/** Un élément d'animation déjà connu du plan, parmi ceux-ci. */
export function anyAnimation(itemIds: readonly string[]): boolean {
  const one = db().prepare("SELECT 1 FROM xray_scan_items WHERE item_id = ? AND status = 'excluded' AND reason = 'animation'");
  return itemIds.some((id) => one.get(id.toLowerCase()) !== undefined);
}

// ─── Les réglages du fond ───────────────────────────────────────────────────

export function readMeta<T>(key: string): T | null {
  const row = db().prepare("SELECT value FROM xray_scan_meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function writeMeta(key: string, value: unknown): void {
  db().prepare("INSERT INTO xray_scan_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

/** Pour les tests : tout oublier. */
export function wipeScanStore(): void {
  const d = db();
  d.exec("DELETE FROM xray_scan_items; DELETE FROM xray_scan_meta; DELETE FROM xray_file_versions;");
}

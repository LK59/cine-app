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
 * gardé — sauf si sa date d'import a changé (un fichier nouveau au même élément) : un échec ou un écarté
 * repasse à vérifier. Un élément **fait** ne repasse à vérifier sur une date changée que si sa durée a
 * changé aussi (plus d'une seconde) : la date de Jellyfin (`DateCreated`, quand Radarr/Sonarr n'en
 * donnent pas) bouge à chaque réanalyse de la bibliothèque, et chaque relecture du plan renvoyait des
 * éléments finis à la vérification pour rien (revue du 09/11/2026). Un fichier remplacé à durée égale,
 * c'est la relecture lente de l'`ETag` qui le voit (`staleDone`). Une date inconnue (`0` — une ligne
 * ajoutée par la liste de priorité avant que le plan l'ait lue) n'est pas une date changée.
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
         WHEN xray_scan_items.imported_at <> 0 AND xray_scan_items.imported_at <> excluded.imported_at AND xray_scan_items.status IN ('failed', 'excluded') THEN 'pending'
         WHEN xray_scan_items.imported_at <> 0 AND xray_scan_items.imported_at <> excluded.imported_at AND xray_scan_items.status = 'done'
           AND xray_scan_items.duration_s > 0 AND excluded.duration_s > 0 AND ABS(xray_scan_items.duration_s - excluded.duration_s) > 1 THEN 'pending'
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
/**
 * Dans l'ordre du palier, puis du rang. Depuis 10.30 le rang sert aussi aux paliers 2 et 3 (il y était déjà l'ordre des
 * dates, du plus récent au plus ancien) : il y porte en plus l'ordre des épisodes d'une série (`inEpisodeOrder`).
 */
export function nextPending(tiers: readonly ScanTier[], limit: number): ScanRow[] {
  if (tiers.length === 0) return [];
  const marks = tiers.map(() => "?").join(",");
  return db()
    .prepare(`SELECT ${COLUMNS} FROM xray_scan_items WHERE status = 'pending' AND tier IN (${marks}) ORDER BY tier, rank, item_id LIMIT ?`)
    .all(...tiers, limit) as ScanRow[];
}

/** Les éléments finis dont l'`ETag` n'a pas été relu depuis `before` — la relecture lente. */
export function staleDone(before: number, limit: number): ScanRow[] {
  return db()
    .prepare(`SELECT ${COLUMNS} FROM xray_scan_items WHERE status = 'done' AND COALESCE(checked_at, 0) < ? ORDER BY COALESCE(checked_at, 0) LIMIT ?`)
    .all(before, limit) as ScanRow[];
}

/**
 * Les échecs et les écartés **qui peuvent changer** (sans fichier, sans distribution, hors des dossiers
 * permis) vus pour la dernière fois avant `before` repassent à vérifier — `limit` au plus. Une écriture en
 * base, aucune lecture : la vérification se fait au tour, à leur place dans leur palier. Jusqu'au
 * 09/11/2026 un écarté l'était pour toujours (une fiche TMDB complétée, un fichier arrivé ensuite, rien
 * n'y revenait), et un échec n'était retenté qu'une fois toute la bibliothèque finie. L'animation, elle,
 * suit le genre que relit le plan (`upsertPlanSlice`).
 */
export function reopenStale(before: number, limit: number): number {
  return db()
    .prepare(
      `UPDATE xray_scan_items SET status = 'pending', reason = NULL WHERE item_id IN (
         SELECT item_id FROM xray_scan_items
         WHERE (status = 'failed' OR (status = 'excluded' AND COALESCE(reason, '') <> 'animation')) AND COALESCE(checked_at, 0) < ?
         ORDER BY COALESCE(checked_at, 0) LIMIT ?)`,
    )
    .run(before, limit).changes;
}

/** Les écartés « hors des dossiers permis » repassent tous à vérifier : la liste des dossiers a changé. */
export function reopenOutsideLibrary(): number {
  return db().prepare("UPDATE xray_scan_items SET status = 'pending', reason = NULL WHERE status = 'excluded' AND reason = 'outside-library'").run().changes;
}

/** Le palier 1 tel que retenu (élément → rang) : le plan relu sans la liste des comptes le garde. */
export function storedWatching(): Map<string, number> {
  const rows = db().prepare("SELECT item_id AS itemId, rank FROM xray_scan_items WHERE tier = 1").all() as { itemId: string; rank: number }[];
  return new Map(rows.map((r) => [r.itemId, r.rank]));
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

/**
 * Les séries dont tout le plan est traité (10.30) : aucun épisode en attente ni en file, au moins un fini. Avec
 * leurs épisodes finis dans l'ordre de la série (le titre porte « SxxEyy », zéros compris). Les écartés ne
 * comptent pas ; un échec compte comme traité (il serait sinon attendu pour toujours).
 */
export function finishedSeries(): { seriesId: string; name: string; done: number; itemIds: string[] }[] {
  const rows = db()
    .prepare("SELECT series_id AS seriesId, item_id AS itemId, title, status FROM xray_scan_items WHERE series_id IS NOT NULL AND status != 'excluded'")
    .all() as { seriesId: string; itemId: string; title: string; status: ScanStatus }[];
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const g = by.get(r.seriesId);
    if (g) g.push(r);
    else by.set(r.seriesId, [r]);
  }
  const out: { seriesId: string; name: string; done: number; itemIds: string[] }[] = [];
  for (const [seriesId, g] of by) {
    if (g.some((r) => r.status === "pending" || r.status === "queued")) continue;
    const done = g.filter((r) => r.status === "done").sort((a, b) => a.title.localeCompare(b.title, "en", { numeric: true }));
    if (done.length === 0) continue;
    out.push({ seriesId, name: seriesNameOf(done[0].title), done: done.length, itemIds: done.map((r) => r.itemId) });
  }
  return out;
}

/** Le nom d'une série d'après le titre d'un de ses épisodes dans le plan (« Ted Lasso S01E08 »). */
export function seriesNameOf(title: string): string {
  return title.replace(/\s+S\d+E\d+\s*$/i, "").trim() || title;
}

/** Les épisodes d'une série dans le plan, dans l'ordre de la série, et son nom (la qualité, la réinitialisation). */
export function seriesRows(seriesId: string): { name: string | null; itemIds: string[] } {
  const rows = db()
    .prepare("SELECT item_id AS itemId, title FROM xray_scan_items WHERE series_id = ?")
    .all(seriesId.toLowerCase()) as { itemId: string; title: string }[];
  rows.sort((a, b) => a.title.localeCompare(b.title, "en", { numeric: true }));
  return { name: rows.length ? seriesNameOf(rows[0].title) : null, itemIds: rows.map((r) => r.itemId) };
}

/** Pour les tests : tout oublier. */
export function wipeScanStore(): void {
  const d = db();
  d.exec("DELETE FROM xray_scan_items; DELETE FROM xray_scan_meta; DELETE FROM xray_file_versions;");
}

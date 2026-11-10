import { getDb } from "@/lib/db";
import type { XraySubsyncTrack } from "@/lib/clients/xray";
import { isNeutralSync, subtitleTrackKey, type SubtitleSync } from "@/lib/subtitleSync";
import { APPLICABLE_VERDICTS, type SyncAction, type SyncStatus, type SyncVerdict } from "./types";

/**
 * « Synchro des sous-titres » dans `cine.db` (DECISIONS.md §141) — les tables sont créées par `migrate()`
 * (`db.ts`). Toutes les requêtes sont synchrones (CLAUDE.md) et portent sur la clé primaire ou l'index
 * `(series_id, season)` : la lecture des corrections appliquées, sur le chemin de l'ouverture d'un film, est une
 * recherche par préfixe de clé.
 */

export interface SyncRow {
  item_id: string;
  track_key: string;
  media_etag: string;
  ext_size: number | null;
  ext_mtime: number | null;
  kind: "embedded" | "external";
  stream_index: number | null;
  codec: string | null;
  language: string | null;
  title: string | null;
  forced: number;
  hi: number;
  offset_s: number | null;
  scale: number | null;
  scale_label: string | null;
  z: number | null;
  mad_ms: number | null;
  windows: number | null;
  inliers: number | null;
  cover: number | null;
  max_error_s: number | null;
  confidence: string | null;
  verdict: SyncVerdict;
  reliable: number;
  status: SyncStatus;
  measured_at: number;
  decided_at: number | null;
  decided_by: string | null;
  speech_source: string | null;
  algo_version: number | null;
  item_kind: string | null;
  item_title: string | null;
  series_id: string | null;
  series_title: string | null;
  season: number | null;
  episode: number | null;
}

export interface ItemMeta {
  itemKind: "Movie" | "Episode";
  itemTitle: string;
  seriesId: string | null;
  seriesTitle: string | null;
  season: number | null;
  episode: number | null;
}

export interface JobRow {
  item_id: string;
  season: number | null;
  episode: number | null;
  media_etag: string;
  state: "queued" | "done" | "failed";
  error: string | null;
  pass_id: string;
  launched_at: number;
  launched_by: string | null;
  finished_at: number | null;
  item_kind: string | null;
  item_title: string | null;
  series_id: string | null;
  series_title: string | null;
}

const sameNumber = (a: number | null, b: number | null, tolerance: number) =>
  a === null || b === null ? a === b : Math.abs(a - b) <= tolerance;

/**
 * Écrit les mesures d'un élément. Une décision (`applied` / `rejected`) ne survit qu'à une mesure du même
 * fichier qui dit la même chose (décalage au millième, même échelle) : un fichier changé, ou une mesure
 * différente, revient à `measured` — l'administrateur redécide, rien n'est appliqué d'office.
 * Les pistes que la nouvelle mesure ne connaît plus (un fichier à côté retiré) sont effacées.
 */
export function recordMeasurement(itemId: string, mediaEtag: string, meta: ItemMeta, speechSource: string | null, version: number | null,
  tracks: XraySubsyncTrack[], now = Date.now()): void {
  const db = getDb();
  const id = itemId.toLowerCase();
  const existing = new Map(
    (db.prepare("SELECT * FROM subtitle_sync WHERE item_id = ?").all(id) as SyncRow[]).map((r) => [r.track_key, r]),
  );
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO subtitle_sync (item_id, track_key, media_etag, ext_size, ext_mtime, kind, stream_index, codec,
       language, title, forced, hi, offset_s, scale, scale_label, z, mad_ms, windows, inliers, cover, max_error_s, confidence,
       verdict, reliable, status, measured_at, decided_at, decided_by, speech_source, algo_version, item_kind, item_title,
       series_id, series_title, season, episode)
     VALUES (@item_id, @track_key, @media_etag, @ext_size, @ext_mtime, @kind, @stream_index, @codec, @language, @title, @forced,
       @hi, @offset_s, @scale, @scale_label, @z, @mad_ms, @windows, @inliers, @cover, @max_error_s, @confidence, @verdict,
       @reliable, @status, @measured_at, @decided_at, @decided_by, @speech_source, @algo_version, @item_kind, @item_title,
       @series_id, @series_title, @season, @episode)`,
  );
  db.transaction(() => {
    const keep = new Set<string>();
    for (const t of tracks) {
      if (!t || typeof t.trackKey !== "string") continue;
      keep.add(t.trackKey);
      const prev = existing.get(t.trackKey);
      const offset = typeof t.offset === "number" && Number.isFinite(t.offset) ? t.offset : null;
      const scale = typeof t.scale === "number" && Number.isFinite(t.scale) && t.scale > 0 ? t.scale : null;
      const sameDecision =
        prev !== undefined &&
        prev.status !== "measured" &&
        prev.media_etag === mediaEtag &&
        (prev.ext_size ?? null) === (t.size ?? null) &&
        (prev.ext_mtime ?? null) === (t.mtime ?? null) &&
        sameNumber(prev.offset_s, offset, 0.001) &&
        sameNumber(prev.scale, scale, 1e-9);
      upsert.run({
        item_id: id,
        track_key: t.trackKey,
        media_etag: mediaEtag,
        ext_size: t.size ?? null,
        ext_mtime: t.mtime ?? null,
        kind: t.kind === "external" ? "external" : "embedded",
        stream_index: typeof t.streamIndex === "number" ? t.streamIndex : null,
        codec: t.codec ?? null,
        language: t.language ?? null,
        title: t.title ?? null,
        forced: t.forced ? 1 : 0,
        hi: t.hi ? 1 : 0,
        offset_s: offset,
        scale,
        scale_label: t.scaleLabel ?? null,
        z: t.z ?? null,
        mad_ms: t.madMs ?? null,
        windows: typeof t.windows === "number" ? t.windows : null,
        inliers: t.inliers ?? null,
        cover: t.cover ?? null,
        max_error_s: t.maxErrorS ?? null,
        confidence: t.confidence ?? null,
        verdict: t.verdict,
        reliable: t.reliable ? 1 : 0,
        status: sameDecision ? prev!.status : "measured",
        measured_at: now,
        decided_at: sameDecision ? prev!.decided_at : null,
        decided_by: sameDecision ? prev!.decided_by : null,
        speech_source: speechSource,
        algo_version: version,
        item_kind: meta.itemKind,
        item_title: meta.itemTitle,
        series_id: meta.seriesId,
        series_title: meta.seriesTitle,
        season: meta.season,
        episode: meta.episode,
      });
    }
    for (const key of existing.keys()) {
      if (!keep.has(key)) db.prepare("DELETE FROM subtitle_sync WHERE item_id = ? AND track_key = ?").run(id, key);
    }
  })();
}

export function rowsForItems(itemIds: readonly string[]): SyncRow[] {
  if (itemIds.length === 0) return [];
  const db = getDb();
  const out: SyncRow[] = [];
  for (let i = 0; i < itemIds.length; i += 500) {
    const chunk = itemIds.slice(i, i + 500).map((x) => x.toLowerCase());
    out.push(...(db.prepare(`SELECT * FROM subtitle_sync WHERE item_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as SyncRow[]));
  }
  return out;
}

export function allRows(): SyncRow[] {
  return getDb().prepare("SELECT * FROM subtitle_sync ORDER BY series_title, season, episode, item_title").all() as SyncRow[];
}

export function rowsForSeries(seriesId: string): SyncRow[] {
  return getDb().prepare("SELECT * FROM subtitle_sync WHERE series_id = ?").all(seriesId.toLowerCase()) as SyncRow[];
}

/**
 * Les corrections **appliquées** d'un élément pour ce fichier-ci (`media_etag` égal à l'`ETag` que Jellyfin donne
 * maintenant), par clé de piste. Une version différente du fichier n'en a aucune : la ligne est périmée. Ne lève
 * jamais — lue sur le chemin de l'ouverture d'un film, une base illisible vaut « aucune correction ».
 */
export function appliedFor(itemId: string, mediaEtag: string | null | undefined): Map<string, SubtitleSync & { label: string | null; version: number }> {
  const out = new Map<string, SubtitleSync & { label: string | null; version: number }>();
  if (!mediaEtag) return out;
  try {
    const rows = getDb()
      .prepare("SELECT track_key, offset_s, scale, scale_label, decided_at FROM subtitle_sync WHERE item_id = ? AND status = 'applied' AND media_etag = ?")
      .all(itemId.toLowerCase(), mediaEtag) as Pick<SyncRow, "track_key" | "offset_s" | "scale" | "scale_label" | "decided_at">[];
    for (const r of rows) {
      const sync = { offset: r.offset_s ?? 0, scale: r.scale ?? 1 };
      if (isNeutralSync(sync)) continue;
      out.set(r.track_key, { ...sync, label: r.scale_label, version: r.decided_at ?? 0 });
    }
  } catch {
    /* aucune correction plutôt qu'une ouverture qui tombe */
  }
  return out;
}

/**
 * Les corrections appliquées, par index Jellyfin : la clé de la table (`emb:<index>`, `ext:<chemin>`) ramenée à
 * l'index que les lecteurs connaissent — la route `direct` (lecteur natif), `playback/start` (lecteur serveur),
 * les sous-titres d'un téléchargement. Seulement pour l'`ETag` que Jellyfin donne maintenant. Ne lève jamais.
 */
export function subtitleSyncByIndex(
  itemId: string,
  etag: string | null | undefined,
  streams: readonly { Type?: string; Index?: number; IsExternal?: boolean; Path?: string | null }[]
): Record<string, SubtitleSync & { label: string | null; version: number }> | undefined {
  const applied = appliedFor(itemId, etag);
  if (applied.size === 0) return undefined;
  const out: Record<string, SubtitleSync & { label: string | null; version: number }> = {};
  for (const s of streams) {
    if (s.Type !== "Subtitle" || typeof s.Index !== "number") continue;
    const key = subtitleTrackKey({ Index: s.Index, IsExternal: s.IsExternal, Path: s.Path });
    const sync = key ? applied.get(key) : undefined;
    if (sync) out[String(s.Index)] = sync;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Une décision sur des pistes. `apply` n'applique que ce qui a un décalage mesuré et n'est pas périmé
 * (`currentEtag`) ; `strict` (une saison, une série, un élément entier) seulement une mesure fiable d'un décalage
 * ou d'une dérive. `reject` refuse, `reset` revient à « mesuré ». Rend le nombre de pistes changées.
 */
export function decide(
  rows: SyncRow[],
  action: SyncAction,
  by: string,
  opts: { strict: boolean; currentEtag: (itemId: string) => string | null | undefined },
  now = Date.now(),
): number {
  const db = getDb();
  const set = db.prepare("UPDATE subtitle_sync SET status = ?, decided_at = ?, decided_by = ? WHERE item_id = ? AND track_key = ?");
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (action === "apply") {
        if (r.offset_s === null || r.scale === null) continue;
        if (opts.strict && !(r.reliable && APPLICABLE_VERDICTS.includes(r.verdict))) continue;
        const current = opts.currentEtag(r.item_id);
        // Version du fichier inconnue (Jellyfin ne répond pas) ou différente : jamais appliquée.
        if (!current || current !== r.media_etag) continue;
        set.run("applied", now, by, r.item_id, r.track_key);
      } else if (action === "reject") {
        if (r.verdict === "image") continue;
        set.run("rejected", now, by, r.item_id, r.track_key);
      } else {
        set.run("measured", null, null, r.item_id, r.track_key);
      }
      changed++;
    }
  })();
  return changed;
}

// ─── Les mesures demandées ───────────────────────────────────────────────────

export function recordJob(itemId: string, mediaEtag: string, passId: string, by: string | null, meta: ItemMeta, now = Date.now()): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO subtitle_sync_jobs (item_id, media_etag, state, error, pass_id, launched_at, launched_by, finished_at,
         item_kind, item_title, series_id, series_title, season, episode)
       VALUES (?, ?, 'queued', NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(itemId.toLowerCase(), mediaEtag, passId, now, by, meta.itemKind, meta.itemTitle, meta.seriesId, meta.seriesTitle, meta.season, meta.episode);
}

export function failJob(itemId: string, error: string, now = Date.now()): void {
  getDb().prepare("UPDATE subtitle_sync_jobs SET state = 'failed', error = ?, finished_at = ? WHERE item_id = ?").run(error.slice(0, 300), now, itemId.toLowerCase());
}

export function finishJob(itemId: string, now = Date.now()): void {
  getDb().prepare("UPDATE subtitle_sync_jobs SET state = 'done', error = NULL, finished_at = ? WHERE item_id = ?").run(now, itemId.toLowerCase());
}

export function pendingJobs(): JobRow[] {
  return getDb().prepare("SELECT * FROM subtitle_sync_jobs WHERE state = 'queued' ORDER BY launched_at").all() as JobRow[];
}

export function jobsForItems(itemIds: readonly string[]): JobRow[] {
  if (itemIds.length === 0) return [];
  const out: JobRow[] = [];
  for (let i = 0; i < itemIds.length; i += 500) {
    const chunk = itemIds.slice(i, i + 500).map((x) => x.toLowerCase());
    out.push(...(getDb().prepare(`SELECT * FROM subtitle_sync_jobs WHERE item_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as JobRow[]));
  }
  return out;
}

export function allJobs(): JobRow[] {
  return getDb().prepare("SELECT * FROM subtitle_sync_jobs").all() as JobRow[];
}

/** Ce qu'une passe (un clic) a donné, une fois toutes ses mesures revenues ; `null` tant qu'il en reste. */
export function passSummary(passId: string): { items: number; failed: number; tracks: number; byVerdict: Record<string, number> } | null {
  const db = getDb();
  const jobs = db.prepare("SELECT item_id, state FROM subtitle_sync_jobs WHERE pass_id = ?").all(passId) as { item_id: string; state: string }[];
  if (jobs.length === 0 || jobs.some((j) => j.state === "queued")) return null;
  const rows = rowsForItems(jobs.map((j) => j.item_id));
  const byVerdict: Record<string, number> = {};
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  return { items: jobs.length, failed: jobs.filter((j) => j.state === "failed").length, tracks: rows.length, byVerdict };
}

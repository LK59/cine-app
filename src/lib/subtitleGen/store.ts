import { getDb } from "@/lib/db";

/**
 * Les tâches de sous-titres générés dans SQLite (DECISIONS.md §69). Tables créées par `migrate()`
 * (db.ts). Chaque requête est synchrone et tient la boucle d'événements : elles sont courtes, et
 * l'écriture d'un lot est une seule transaction.
 */

export type JobStatus = "preparing" | "running" | "paused" | "done" | "failed" | "stale";

/** Où en est la présentation du fichier à Jellyfin, une fois toutes les lignes faites. */
export type PresentState = "pending" | "uploaded" | "presented" | "failed";

export interface JobRow {
  id: string;
  item_id: string;
  media_source_id: string;
  file_etag: string | null;
  file_size: number | null;
  video_path: string | null;
  title: string | null;
  runtime_seconds: number | null;
  target: string;
  candidates: string;
  source_index: number | null;
  source_external: number | null;
  source_lang: string | null;
  source_hi: number;
  source_hash: string | null;
  provider: string;
  model: string;
  glossary: string | null;
  status: JobStatus;
  reason: string | null;
  total: number;
  done: number;
  rev: number;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
  requests: number;
  kept_source: number;
  last_position: number | null;
  first_ms: number | null;
  out_hash: string | null;
  present_state: PresentState | null;
  present_reason: string | null;
  present_attempts: number;
  present_next_at: number | null;
  present_pre_paths: string | null;
  present_path: string | null;
  present_index: number | null;
  present_uploaded_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface CueRow {
  idx: number;
  start_s: number;
  end_s: number;
  source: string;
  text: string | null;
  kept: number;
  rev: number;
}

const db = () => getDb();

export const jobsDb = {
  insert(row: Pick<JobRow, "id" | "item_id" | "media_source_id" | "file_etag" | "file_size" | "video_path" | "title" | "runtime_seconds" | "target" | "candidates" | "provider" | "model" | "created_by" | "last_position">): void {
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO subtitle_gen_jobs (id, item_id, media_source_id, file_etag, file_size, video_path, title, runtime_seconds, target, candidates, provider, model, status, created_by, last_position, created_at, updated_at)
         VALUES (@id, @item_id, @media_source_id, @file_etag, @file_size, @video_path, @title, @runtime_seconds, @target, @candidates, @provider, @model, 'preparing', @created_by, @last_position, @now, @now)`
      )
      .run({ ...row, now });
  },

  get(id: string): JobRow | null {
    return (db().prepare("SELECT * FROM subtitle_gen_jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null;
  },

  /** La tâche vivante pour ce fichier et cette langue — celle qu'un second compte rejoint. */
  findLive(itemId: string, mediaSourceId: string, target: string): JobRow | null {
    return (
      (db()
        .prepare("SELECT * FROM subtitle_gen_jobs WHERE item_id = ? AND media_source_id = ? AND target = ? AND status NOT IN ('stale', 'failed') ORDER BY created_at DESC LIMIT 1")
        .get(itemId, mediaSourceId, target) as JobRow | undefined) ?? null
    );
  },

  /** Une tâche a-t-elle déjà existé pour ce titre et cette langue (quelle que soit son issue) ? */
  hadAny(itemId: string, target: string): boolean {
    return !!db().prepare("SELECT 1 FROM subtitle_gen_jobs WHERE item_id = ? AND target = ? LIMIT 1").get(itemId, target);
  },

  forItem(itemId: string): JobRow[] {
    return db().prepare("SELECT * FROM subtitle_gen_jobs WHERE item_id = ? AND status != 'stale' ORDER BY created_at").all(itemId) as JobRow[];
  },

  withStatus(statuses: JobStatus[]): JobRow[] {
    const marks = statuses.map(() => "?").join(",");
    return db().prepare(`SELECT * FROM subtitle_gen_jobs WHERE status IN (${marks}) ORDER BY created_at`).all(...statuses) as JobRow[];
  },

  /** Les tâches terminées dont la présentation à Jellyfin reste à faire ou à vérifier. */
  presenting(): JobRow[] {
    return db().prepare("SELECT * FROM subtitle_gen_jobs WHERE status = 'done' AND present_state IN ('pending', 'uploaded')").all() as JobRow[];
  },

  recent(limit: number): JobRow[] {
    return db().prepare("SELECT * FROM subtitle_gen_jobs ORDER BY updated_at DESC LIMIT ?").all(limit) as JobRow[];
  },

  update(id: string, patch: Partial<Omit<JobRow, "id">>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    db()
      .prepare(`UPDATE subtitle_gen_jobs SET ${sets}, updated_at = @__now WHERE id = @__id`)
      .run({ ...patch, __now: Date.now(), __id: id });
  },

  /** L'usage d'un appel, ajouté à la tâche — entrée, écriture et lecture du cache comptées à part. */
  addUsage(id: string, u: UsageCounts, cost: number): void {
    db()
      .prepare(
        "UPDATE subtitle_gen_jobs SET input_tokens = input_tokens + ?, cache_write_tokens = cache_write_tokens + ?, cache_read_tokens = cache_read_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?, requests = requests + 1, updated_at = ? WHERE id = ?"
      )
      .run(u.inputTokens, u.cacheWriteTokens, u.cacheReadTokens, u.outputTokens, cost, Date.now(), id);
  },
};

export const cuesDb = {
  replaceAll(jobId: string, cues: { start: number; end: number; text: string }[]): void {
    const d = db();
    const insert = d.prepare("INSERT INTO subtitle_gen_cues (job_id, idx, start_s, end_s, source) VALUES (?, ?, ?, ?, ?)");
    d.transaction(() => {
      d.prepare("DELETE FROM subtitle_gen_cues WHERE job_id = ?").run(jobId);
      cues.forEach((c, i) => insert.run(jobId, i, c.start, c.end, c.text));
    })();
  },

  all(jobId: string): CueRow[] {
    return db().prepare("SELECT idx, start_s, end_s, source, text, kept, rev FROM subtitle_gen_cues WHERE job_id = ? ORDER BY idx").all(jobId) as CueRow[];
  },

  since(jobId: string, rev: number): CueRow[] {
    return db()
      .prepare("SELECT idx, start_s, end_s, source, text, kept, rev FROM subtitle_gen_cues WHERE job_id = ? AND rev > ? AND text IS NOT NULL ORDER BY idx")
      .all(jobId, rev) as CueRow[];
  },

  /**
   * Écrit des lignes traduites, en une transaction : seulement celles encore vides (rien n'est
   * jamais retraduit ni écrasé), sous une révision nouvelle que le sondage du lecteur suit.
   * Rend la révision et le nombre de lignes faites.
   */
  write(jobId: string, entries: { idx: number; text: string; kept: boolean }[]): { rev: number; done: number; written: number } {
    const d = db();
    return d.transaction(() => {
      const job = d.prepare("SELECT rev FROM subtitle_gen_jobs WHERE id = ?").get(jobId) as { rev: number } | undefined;
      const rev = (job?.rev ?? 0) + 1;
      const stmt = d.prepare("UPDATE subtitle_gen_cues SET text = ?, kept = ?, rev = ? WHERE job_id = ? AND idx = ? AND text IS NULL");
      let written = 0;
      let kept = 0;
      for (const e of entries) {
        const changes = stmt.run(e.text, e.kept ? 1 : 0, rev, jobId, e.idx).changes;
        written += changes;
        if (changes && e.kept) kept++;
      }
      d.prepare(
        "UPDATE subtitle_gen_jobs SET rev = ?, done = (SELECT COUNT(*) FROM subtitle_gen_cues WHERE job_id = ? AND text IS NOT NULL), kept_source = kept_source + ?, updated_at = ? WHERE id = ?"
      ).run(rev, jobId, kept, Date.now(), jobId);
      const done = (d.prepare("SELECT done FROM subtitle_gen_jobs WHERE id = ?").get(jobId) as { done: number }).done;
      return { rev, done, written };
    })();
  },
};

/** Le mois en cours, en UTC — le budget est mensuel, comme la facture. */
export function monthOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function dayOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface UsageCounts {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export const spendDb = {
  add(cost: number, u: UsageCounts, now = Date.now()): void {
    db()
      .prepare(
        `INSERT INTO subtitle_gen_spend (month, cost_usd, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, requests) VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(month) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, input_tokens = input_tokens + excluded.input_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           output_tokens = output_tokens + excluded.output_tokens, requests = requests + 1`
      )
      .run(monthOf(now), cost, u.inputTokens, u.cacheWriteTokens, u.cacheReadTokens, u.outputTokens);
  },
  month(now = Date.now()): UsageCounts & { cost: number; requests: number } {
    const row = db()
      .prepare("SELECT cost_usd, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, requests FROM subtitle_gen_spend WHERE month = ?")
      .get(monthOf(now)) as
      | { cost_usd: number; input_tokens: number; cache_write_tokens: number; cache_read_tokens: number; output_tokens: number; requests: number }
      | undefined;
    return {
      cost: row?.cost_usd ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      cacheWriteTokens: row?.cache_write_tokens ?? 0,
      cacheReadTokens: row?.cache_read_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      requests: row?.requests ?? 0,
    };
  },
};

/**
 * Les générations qu'un compte peut **lancer** par jour (50 depuis le 12/10/2026, décidé par Louis ;
 * 30 au départ). Rejoindre une tâche qui court, la reprendre ou la refaire ne compte pas.
 */
export const DAILY_LIMIT = 50;

export const quotaDb = {
  used(user: string, now = Date.now()): number {
    const row = db().prepare("SELECT count FROM subtitle_gen_quota WHERE user_name = ? AND day = ?").get(user, dayOf(now)) as { count: number } | undefined;
    return row?.count ?? 0;
  },
  add(user: string, now = Date.now()): void {
    db()
      .prepare("INSERT INTO subtitle_gen_quota (user_name, day, count) VALUES (?, ?, 1) ON CONFLICT(user_name, day) DO UPDATE SET count = count + 1")
      .run(user, dayOf(now));
  },
};

/**
 * Le même fichier vidéo qu'à la création de la tâche ? L'`ETag` de la source Jellyfin et la taille,
 * comme le cache de reprise (`src/lib/resumeCache/`) : Sonarr remplace un fichier par une meilleure
 * version, FileFlows réencode chaque nouveau fichier — une traduction calée sur l'ancien serait
 * décalée sur le nouveau.
 */
export function sameFile(job: Pick<JobRow, "file_etag" | "file_size">, source: { etag: string | null; size: number | null }): boolean {
  return (job.file_etag ?? null) === (source.etag ?? null) && (job.file_size ?? null) === (source.size ?? null);
}

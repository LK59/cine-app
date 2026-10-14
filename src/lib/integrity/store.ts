import { getDb } from "@/lib/db";
import type { ZoneFound } from "./scan";

/** Ce que la vérification de l'intégrité garde en base (DECISIONS.md §93), table `file_integrity`. */

export type IntegrityStatus = "ok" | "damaged" | "unsupported" | "error";
export type IntegrityKind = "movie" | "episode";

export interface IntegrityRecord {
  path: string;
  size: number;
  mtimeMs: number;
  kind: IntegrityKind;
  title: string | null;
  /** Radarr (film) ou Sonarr (série) — de quoi ouvrir sa page de gestion pour remplacer le fichier. */
  serviceId: number | null;
  status: IntegrityStatus;
  zones: ZoneFound[];
  /** Plus de zones que la liste n'en garde, ou une fin de fichier inatteignable après la dernière. */
  truncated?: boolean;
  unreachableTail?: boolean;
  error: string | null;
  bytesRead: number;
  ms: number;
  checkedAt: number;
}

type Row = {
  path: string;
  size: number;
  mtime_ms: number;
  kind: string;
  title: string | null;
  service_id: number | null;
  status: string;
  zones: string | null;
  error: string | null;
  bytes_read: number;
  ms: number;
  checked_at: number;
};

function fromRow(row: Row): IntegrityRecord {
  let zones: ZoneFound[] = [];
  let truncated: boolean | undefined;
  let unreachableTail: boolean | undefined;
  try {
    const parsed = row.zones ? (JSON.parse(row.zones) as { list?: ZoneFound[]; truncated?: boolean; unreachableTail?: boolean }) : null;
    zones = Array.isArray(parsed?.list) ? parsed.list : [];
    truncated = parsed?.truncated || undefined;
    unreachableTail = parsed?.unreachableTail || undefined;
  } catch {
    zones = [];
  }
  return {
    path: row.path,
    size: row.size,
    mtimeMs: row.mtime_ms,
    kind: row.kind === "episode" ? "episode" : "movie",
    title: row.title,
    serviceId: row.service_id,
    status: (["ok", "damaged", "unsupported", "error"].includes(row.status) ? row.status : "error") as IntegrityStatus,
    zones,
    ...(truncated ? { truncated } : {}),
    ...(unreachableTail ? { unreachableTail } : {}),
    error: row.error,
    bytesRead: row.bytes_read,
    ms: row.ms,
    checkedAt: row.checked_at,
  };
}

export const integrityDb = {
  /** La signature de chaque fichier déjà relu : chemin → taille et date. */
  signatures(): Map<string, { size: number; mtimeMs: number; status: IntegrityStatus }> {
    const rows = getDb().prepare("SELECT path, size, mtime_ms, status FROM file_integrity").all() as { path: string; size: number; mtime_ms: number; status: string }[];
    return new Map(rows.map((r) => [r.path, { size: r.size, mtimeMs: r.mtime_ms, status: r.status as IntegrityStatus }]));
  },

  save(record: IntegrityRecord): void {
    const zones = record.zones.length || record.truncated || record.unreachableTail ? JSON.stringify({ list: record.zones, truncated: record.truncated, unreachableTail: record.unreachableTail }) : null;
    getDb()
      .prepare(
        `INSERT INTO file_integrity (path, size, mtime_ms, kind, title, service_id, status, zones, error, bytes_read, ms, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, kind = excluded.kind, title = excluded.title,
           service_id = excluded.service_id, status = excluded.status, zones = excluded.zones, error = excluded.error,
           bytes_read = excluded.bytes_read, ms = excluded.ms, checked_at = excluded.checked_at`
      )
      .run(record.path, record.size, Math.round(record.mtimeMs), record.kind, record.title, record.serviceId, record.status, zones, record.error, record.bytesRead, record.ms, record.checkedAt);
  },

  /** Un fichier disparu de la bibliothèque : sa ligne part avec lui. */
  forget(path: string): void {
    getDb().prepare("DELETE FROM file_integrity WHERE path = ?").run(path);
  },

  /** Les fichiers abîmés (et ceux qu'on n'a pas pu relire), pour la page. */
  problems(limit = 500): IntegrityRecord[] {
    const rows = getDb()
      .prepare("SELECT * FROM file_integrity WHERE status IN ('damaged', 'error') ORDER BY status = 'damaged' DESC, title, path LIMIT ?")
      .all(limit) as Row[];
    return rows.map(fromRow);
  },

  counts(): Record<IntegrityStatus, number> & { bytes: number } {
    const rows = getDb().prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM file_integrity GROUP BY status").all() as { status: string; n: number; bytes: number }[];
    const out = { ok: 0, damaged: 0, unsupported: 0, error: 0, bytes: 0 };
    for (const r of rows) {
      if (r.status in out) out[r.status as IntegrityStatus] = r.n;
      if (r.status !== "unsupported") out.bytes += r.bytes;
    }
    return out;
  },

  readMeta<T>(key: string): T | null {
    const row = getDb().prepare("SELECT value FROM file_integrity_meta WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  },

  writeMeta(key: string, value: unknown): void {
    getDb()
      .prepare("INSERT INTO file_integrity_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  },
};

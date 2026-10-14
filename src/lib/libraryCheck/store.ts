import { getDb } from "@/lib/db";
import type { LibraryCheckResult } from "./types";

/**
 * Ce que le contrôle de la bibliothèque garde en base (DECISIONS.md §90) : son dernier résultat, et
 * les séries dont l'administrateur a décidé que Jellyfin a les bons noms d'épisodes (§89).
 */

/**
 * « Faire confiance à Jellyfin pour les noms d'épisodes », par série Sonarr.
 *
 * La règle de §89 donne les noms d'épisodes à Sonarr quand il rattache un fichier à un autre numéro
 * que le disque : c'est juste quand le disque est mal numéroté, faux quand c'est Sonarr qui numérote
 * autrement que le disque *voulu* (l'ordre de diffusion d'un animé, des parties Netflix rangées en
 * saisons). Ce cas-là ne se devine pas ; il se décide, série par série, et se retire de même.
 */
export const episodeTextTrustDb = {
  has(sonarrId: number): boolean {
    return !!getDb().prepare("SELECT 1 FROM episode_text_trust WHERE sonarr_id = ?").get(sonarrId);
  },

  all(): { sonarrId: number; title: string | null; setBy: string | null; createdAt: number }[] {
    const rows = getDb().prepare("SELECT sonarr_id, title, set_by, created_at FROM episode_text_trust ORDER BY created_at").all() as {
      sonarr_id: number;
      title: string | null;
      set_by: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({ sonarrId: r.sonarr_id, title: r.title, setBy: r.set_by, createdAt: r.created_at }));
  },

  set(sonarrId: number, trusted: boolean, info: { title?: string | null; by?: string | null } = {}, now = Date.now()): void {
    if (trusted) {
      getDb()
        .prepare(
          `INSERT INTO episode_text_trust (sonarr_id, title, set_by, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (sonarr_id) DO UPDATE SET title = excluded.title, set_by = excluded.set_by`
        )
        .run(sonarrId, info.title ?? null, info.by ?? null, now);
    } else {
      getDb().prepare("DELETE FROM episode_text_trust WHERE sonarr_id = ?").run(sonarrId);
    }
  },
};

/** Le dernier résultat du contrôle — une seule ligne, remplacée à chaque analyse. */
export const libraryCheckDb = {
  get(): LibraryCheckResult | null {
    const row = getDb().prepare("SELECT result FROM library_check WHERE id = 1").get() as { result: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.result) as LibraryCheckResult;
      return parsed && parsed.version === LIBRARY_CHECK_VERSION ? parsed : null;
    } catch {
      return null;
    }
  },

  set(result: LibraryCheckResult): void {
    getDb()
      .prepare(
        `INSERT INTO library_check (id, result, computed_at, duration_ms) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET result = excluded.result, computed_at = excluded.computed_at, duration_ms = excluded.duration_ms`
      )
      .run(JSON.stringify(result), result.computedAt, result.durationMs);
  },
};

/** Monte quand la forme du résultat change : un résultat d'une autre forme est relu comme absent. */
export const LIBRARY_CHECK_VERSION = 1;

import { jellyfin, type JellyfinItem } from "@/lib/clients/jellyfin";
import { watchedDb, type WatchedRow } from "@/lib/db";
import { cachedJellyfinMoviesAdmin, cachedJellyfinPlayed, cachedJellyfinSeriesAdmin, getProviderIdCI, invalidateKey } from "@/lib/server-cache";
import { logError } from "@/lib/logger";

/**
 * Le « vu » d'un compte — la règle décidée le 06/10/2026 (DECISIONS.md §51), qui remplace « le vu
 * appartient à Jellyfin seul » (§6) :
 *
 * - **Le titre est dans Jellyfin** : Jellyfin fait foi. Marquer ou démarquer un film écrit chez lui ;
 *   une lecture complète l'y marque d'elle-même. CineApp en garde une copie à jour en permanence.
 * - **Il n'y est pas** (vu ailleurs, ou parti de la bibliothèque) : la copie locale est la seule
 *   trace, et le vu d'un compte ne se perd jamais.
 * - **Il arrive dans Jellyfin** : le vu y est reporté. **Il en part** : la copie reste.
 * - **Désaccord** pendant que le titre est présent : la dernière modification gagne. Un film que
 *   Jellyfin disait vu et ne dit plus a été démarqué chez lui — on suit, la copie ne lui impose
 *   jamais un ancien état.
 * - **Une série** est vue quand tous ses épisodes le sont (Jellyfin), ou quand elle est marquée vue
 *   à la main : un état posé sur la série, chez nous, **sans cocher aucun épisode** — Jellyfin garde
 *   le détail réel de ce qui a été vu. Elle quitte alors « Reprendre » et « À suivre », sauf pour un
 *   épisode entré dans la bibliothèque après le marquage (`seriesStillHidden`).
 */

export interface Who {
  /** La clé du compte dans nos tables : son identifiant Jellyfin, sinon son nom (comme « À voir »). */
  userId: string;
  /** Son identifiant Jellyfin, sans lequel rien ne s'écrit ni ne se lit chez Jellyfin. */
  jfId: string | null;
}

export type WatchedType = "movie" | "series";
export interface TitleMeta {
  title?: string;
  year?: number | null;
  posterPath?: string | null;
}

/** La bibliothèque Jellyfin vue par TMDB : quel élément pour quel titre, et l'inverse. */
export interface LibraryIndex {
  movies: Map<number, string>;
  series: Map<number, string>;
  /** Identifiant Jellyfin → (type, TMDB). */
  byJellyfinId: Map<string, { type: WatchedType; tmdbId: number }>;
}

const tmdbOf = (item: JellyfinItem): number | null => {
  const raw = getProviderIdCI(item.ProviderIds as Record<string, string> | undefined, "tmdb");
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * L'index, ou `null` si Jellyfin ne répond pas. **Nul ne vaut pas vide** : sans lui, on ne sait pas
 * si un titre est présent, et rien de ce qui en dépend — reporter un vu, suivre un démarquage — ne
 * doit se faire sur une supposition (un Jellyfin injoignable aurait sinon tout « fait partir »).
 */
export async function libraryIndex(): Promise<LibraryIndex | null> {
  try {
    const [movies, series] = await Promise.all([cachedJellyfinMoviesAdmin(), cachedJellyfinSeriesAdmin()]);
    const index: LibraryIndex = { movies: new Map(), series: new Map(), byJellyfinId: new Map() };
    for (const m of movies) {
      const t = tmdbOf(m);
      if (t) {
        index.movies.set(t, m.Id);
        index.byJellyfinId.set(m.Id, { type: "movie", tmdbId: t });
      }
    }
    for (const s of series) {
      const t = tmdbOf(s);
      if (t) {
        index.series.set(t, s.Id);
        index.byJellyfinId.set(s.Id, { type: "series", tmdbId: t });
      }
    }
    return index;
  } catch (error) {
    logError("watched-index", error);
    return null;
  }
}

function invalidatePlayed(jfId: string) {
  invalidateKey(`jf:played:${jfId}`);
}

/**
 * Marquer ou démarquer un titre — le seul chemin d'écriture (fiches, découverte, liste).
 *
 * Rend `stillWatched` quand le titre reste vu malgré un démarquage : une série dont tous les
 * épisodes sont vus dans Jellyfin, dont l'état de série ne fait qu'enlever le marquage manuel.
 */
export async function setWatched(who: Who, type: WatchedType, tmdbId: number, on: boolean, meta: TitleMeta = {}): Promise<{ watched: boolean; stillWatched?: boolean }> {
  const index = await libraryIndex();
  const jellyfinId = index ? (type === "movie" ? index.movies.get(tmdbId) : index.series.get(tmdbId)) ?? null : null;
  const present = jellyfinId !== null;
  const existing = watchedDb.get(who.userId, type, tmdbId);

  if (type === "movie") {
    // Chez Jellyfin d'abord : s'il refuse, rien n'est écrit chez nous, et l'erreur remonte.
    if (present && who.jfId) {
      if (on) await jellyfin.markPlayed(who.jfId, jellyfinId!);
      else await jellyfin.markUnplayed(who.jfId, jellyfinId!);
      invalidatePlayed(who.jfId);
    }
    if (on) {
      watchedDb.upsert({ userId: who.userId, mediaType: type, tmdbId, title: meta.title ?? "", year: meta.year ?? null, posterPath: meta.posterPath ?? null, manual: false, jfPresent: present, jfPlayed: present && !!who.jfId, watchedAt: existing ? undefined : Date.now() });
    } else {
      watchedDb.remove(who.userId, type, tmdbId);
    }
    return { watched: on };
  }

  // Une série : l'état de série seulement, jamais ses épisodes.
  if (on) {
    watchedDb.upsert({ userId: who.userId, mediaType: type, tmdbId, title: meta.title ?? "", year: meta.year ?? null, posterPath: meta.posterPath ?? null, manual: true, jfPresent: present, jfPlayed: existing?.jfPlayed ?? false, watchedAt: Date.now() });
    return { watched: true };
  }
  watchedDb.remove(who.userId, type, tmdbId);
  // Tous ses épisodes vus dans Jellyfin : elle reste vue, et la prochaine synchronisation la remet.
  if (present && who.jfId) {
    try {
      const played = await cachedJellyfinPlayed(who.jfId, { forceRefresh: true });
      if (played.some((i) => i.Id === jellyfinId)) return { watched: true, stillWatched: true };
    } catch {
      /* sans réponse, on s'en tient au geste */
    }
  }
  return { watched: false };
}

// ─── La synchronisation avec Jellyfin ─────────────────────────────────────────

const SYNC_EVERY_MS = 60_000;
const lastSync = new Map<string, number>();

/** Pour les tests. */
export function resetWatchedSyncForTests(): void {
  lastSync.clear();
}

/**
 * Accorde la copie locale et Jellyfin, au plus une fois par minute et par compte (à la lecture de
 * « Ma liste » et des flux). Ce qu'elle fait, ligne par ligne :
 *
 * - vu chez Jellyfin, absent de la copie → copié (avec sa date de visionnage) ;
 * - dans la copie, plus vu chez Jellyfin :
 *   - titre absent de la bibliothèque → gardé (il est parti, le vu reste) ;
 *   - film présent, que Jellyfin disait vu au dernier passage → démarqué chez lui : retiré ;
 *   - film présent, que Jellyfin n'avait pas (arrivé depuis) → le vu y est reporté ;
 *   - série présente, qui était entièrement vue et ne l'est plus (un épisode est arrivé, ou un
 *     épisode a été démarqué) → elle reste vue, comme une série marquée à la main ce jour-là : ses
 *     épisodes plus récents la feront revenir dans « À suivre ».
 */
export async function syncWatched(who: Who, opts: { force?: boolean; now?: number } = {}): Promise<void> {
  if (!who.jfId) return;
  const now = opts.now ?? Date.now();
  if (!opts.force && now - (lastSync.get(who.userId) ?? 0) < SYNC_EVERY_MS) return;
  lastSync.set(who.userId, now);

  const [played, index] = await Promise.all([cachedJellyfinPlayed(who.jfId).catch(() => null), libraryIndex()]);
  if (!played) return; // Jellyfin muet : on ne touche à rien

  const rows = watchedDb.all(who.userId);
  const byKey = new Map(rows.map((r) => [`${r.mediaType}:${r.tmdbId}`, r]));
  const playedKeys = new Set<string>();

  for (const item of played) {
    const tmdbId = tmdbOf(item);
    if (!tmdbId) continue;
    const type: WatchedType = item.Type === "Series" ? "series" : "movie";
    const key = `${type}:${tmdbId}`;
    playedKeys.add(key);
    const row = byKey.get(key);
    const lastPlayed = item.UserData?.LastPlayedDate ? Date.parse(item.UserData.LastPlayedDate) : NaN;
    if (!row) {
      watchedDb.upsert({ userId: who.userId, mediaType: type, tmdbId, title: item.Name, year: item.ProductionYear ?? null, posterPath: null, manual: false, jfPresent: true, jfPlayed: true, watchedAt: Number.isFinite(lastPlayed) ? lastPlayed : now }, now);
    } else if (!row.jfPresent || !row.jfPlayed) {
      watchedDb.upsert({ ...row, title: row.title || item.Name, jfPresent: true, jfPlayed: true, watchedAt: undefined }, now);
    }
  }

  if (!index) return; // présence inconnue : rien de ce qui suit ne se décide sans elle
  for (const row of rows) {
    const key = `${row.mediaType}:${row.tmdbId}`;
    if (playedKeys.has(key)) continue;
    const jellyfinId = row.mediaType === "movie" ? index.movies.get(row.tmdbId) : index.series.get(row.tmdbId);
    if (!jellyfinId) {
      if (row.jfPresent) watchedDb.upsert({ ...row, jfPresent: false, watchedAt: undefined }, now);
      continue;
    }
    if (row.mediaType === "movie") {
      if (row.jfPresent && row.jfPlayed) {
        watchedDb.remove(who.userId, row.mediaType, row.tmdbId);
      } else {
        try {
          await jellyfin.markPlayed(who.jfId, jellyfinId);
          invalidatePlayed(who.jfId);
          watchedDb.upsert({ ...row, jfPresent: true, jfPlayed: true, watchedAt: undefined }, now);
        } catch (error) {
          logError("watched-push", error, { tmdbId: row.tmdbId });
        }
      }
    } else if (row.jfPlayed && !row.manual) {
      watchedDb.upsert({ ...row, manual: true, jfPresent: true, jfPlayed: false, watchedAt: undefined }, now);
    } else if (!row.jfPresent) {
      watchedDb.upsert({ ...row, jfPresent: true, watchedAt: undefined }, now);
    }
  }
}

// ─── Ce que les flux lisent ───────────────────────────────────────────────────

/** Les séries vues d'un compte (marquées ou entièrement vues), avec la date qui borne leur retour. */
export function watchedSeries(userId: string): Map<number, number> {
  return new Map(watchedDb.all(userId).filter((r) => r.mediaType === "series").map((r) => [r.tmdbId, r.watchedAt]));
}

/**
 * Un épisode d'une série vue reste-t-il caché de « Reprendre » et « À suivre » ? Oui, sauf s'il est
 * entré dans la bibliothèque après que la série a été vue : c'est la nouvelle saison qui la fait
 * revenir. Sans date d'entrée connue, on ne cache pas — mieux vaut un épisode de trop qu'un oubli.
 */
export function seriesStillHidden(watchedAt: number | undefined, episodeDateCreated: string | undefined): boolean {
  if (watchedAt === undefined) return false;
  const added = episodeDateCreated ? Date.parse(episodeDateCreated) : NaN;
  if (!Number.isFinite(added)) return false;
  return added <= watchedAt;
}

export function watchedRows(userId: string): WatchedRow[] {
  return watchedDb.all(userId);
}

export function isWatchedLocally(userId: string, type: WatchedType, tmdbId: number): boolean {
  return watchedDb.get(userId, type, tmdbId) !== null;
}

/**
 * Ce que « Reprendre » et « À suivre » ne montrent plus : les épisodes d'une série vue (sauf ceux
 * entrés après — `seriesStillHidden`), et un film marqué vu depuis sa dernière lecture. Un film
 * revu après coup revient : sa lecture est plus récente que le marquage.
 *
 * Un seul filtre pour les deux flux — deux copies auraient fini par ne pas cacher la même chose.
 */
export function withoutWatched<T extends JellyfinItem>(userId: string, items: T[], index: LibraryIndex | null): T[] {
  if (!index || items.length === 0) return items;
  const rows = watchedDb.all(userId);
  if (rows.length === 0) return items;
  const series = new Map(rows.filter((r) => r.mediaType === "series").map((r) => [r.tmdbId, r.watchedAt]));
  const movies = new Map(rows.filter((r) => r.mediaType === "movie").map((r) => [r.tmdbId, r.watchedAt]));
  return items.filter((item) => {
    if (item.Type === "Episode" && item.SeriesId) {
      const title = index.byJellyfinId.get(item.SeriesId);
      return !(title?.type === "series" && seriesStillHidden(series.get(title.tmdbId), item.DateCreated));
    }
    if (item.Type === "Movie") {
      const title = index.byJellyfinId.get(item.Id);
      const markedAt = title?.type === "movie" ? movies.get(title.tmdbId) : undefined;
      if (markedAt === undefined) return true;
      const lastPlayed = item.UserData?.LastPlayedDate ? Date.parse(item.UserData.LastPlayedDate) : NaN;
      return Number.isFinite(lastPlayed) && lastPlayed > markedAt;
    }
    return true;
  });
}

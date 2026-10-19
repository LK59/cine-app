import type { OfflineDownload } from "./downloads";

/**
 * L'ordre de la page des téléchargements (bêta, DECISIONS.md §109) : les films, puis les séries —
 * chacune avec ses saisons, chaque saison avec ses épisodes dans l'ordre. Une seule fonction, lue
 * par le panneau du cinéma et par l'entrée hors ligne (`/hors-ligne`) : deux écrans, un classement.
 */

export interface OfflineSeasonGroup {
  season: number;
  episodes: OfflineDownload[];
}

export interface OfflineSeriesGroup {
  /** `sonarrId` quand il est connu, le titre sinon — deux séries homonymes sans id se rejoignent. */
  key: string;
  sonarrId: number | null;
  title: string;
  seasons: OfflineSeasonGroup[];
  /** Le premier épisode de la série dans l'ordre : son affiche représente la série. */
  first: OfflineDownload;
  bytes: number;
}

export interface OfflineGroups {
  films: OfflineDownload[];
  series: OfflineSeriesGroup[];
}

const episodeOrder = (a: OfflineDownload, b: OfflineDownload) =>
  (a.episode!.episodeNumber ?? Number.MAX_SAFE_INTEGER) - (b.episode!.episodeNumber ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt;

export function groupOfflineDownloads(list: readonly OfflineDownload[]): OfflineGroups {
  // Le plus récent d'abord, pour les films comme pour l'ordre des séries : c'est ce qu'on vient de
  // demander qu'on cherche des yeux.
  const recent = [...list].sort((a, b) => b.createdAt - a.createdAt);
  const films = recent.filter((d) => !d.episode);
  const bySeries = new Map<string, OfflineDownload[]>();
  for (const d of recent) {
    if (!d.episode) continue;
    const key = d.episode.sonarrId !== null ? `s${d.episode.sonarrId}` : `t${d.episode.seriesTitle}`;
    const bucket = bySeries.get(key);
    if (bucket) bucket.push(d);
    else bySeries.set(key, [d]);
  }
  const series: OfflineSeriesGroup[] = [];
  for (const [key, episodes] of bySeries) {
    const seasons = new Map<number, OfflineDownload[]>();
    for (const d of episodes) {
      const season = d.episode!.seasonNumber;
      seasons.set(season, [...(seasons.get(season) ?? []), d]);
    }
    const ordered = [...seasons.entries()]
      .sort(([a], [b]) => a - b)
      .map(([season, list]) => ({ season, episodes: list.sort(episodeOrder) }));
    series.push({
      key,
      sonarrId: episodes[0].episode!.sonarrId,
      title: episodes[0].episode!.seriesTitle,
      seasons: ordered,
      first: ordered[0].episodes[0],
      bytes: episodes.reduce((sum, d) => sum + d.bytes, 0),
    });
  }
  return { films, series };
}

/** Ce qui reste à voir, en secondes — nul tant que rien n'a été lu (moins de 30 s : rien à reprendre). */
export function offlineRemainingSeconds(d: OfflineDownload): number | null {
  if (!d.runtimeSeconds || d.positionSeconds < 30) return null;
  return Math.max(0, d.runtimeSeconds - d.positionSeconds);
}

/**
 * L'épisode que « Lire » lance dans la fiche hors ligne d'une série : celui qu'on a commencé, sinon le
 * premier pas encore vu jusqu'au bout, dans l'ordre de la série — la règle de « Reprendre » puis
 * « À suivre », appliquée à ce qui est sur l'appareil. Tous vus : le premier.
 */
export function offlineSeriesNext(group: OfflineSeriesGroup): OfflineDownload | null {
  const ordered = group.seasons.flatMap((s) => s.episodes).filter((d) => d.state !== "failed");
  return ordered.find((d) => !d.watchedToEnd && offlineRemainingSeconds(d) !== null) ?? ordered.find((d) => !d.watchedToEnd) ?? ordered[0] ?? null;
}

import { jellyfin, type JellyfinItem } from "@/lib/clients/jellyfin";
import { sonarr } from "@/lib/clients/sonarr";
import { cachedJellyfinMoviesAdmin, cachedJellyfinSeriesAdmin, cachedMovies, cachedSeries, getProviderIdCI } from "@/lib/server-cache";
import { mapInBatches, yieldToLoop } from "@/lib/inBatches";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { isAnimationGenre, watchingRanks, type EpisodeRef, type LibraryEntry, type WatchingEntry } from "./scanPlan";

/**
 * Ce que le planificateur des acteurs à l'écran lit de la bibliothèque (DECISIONS.md §138,
 * « Le planificateur de la bibliothèque ») : les films et épisodes de Jellyfin (clé du serveur), leurs
 * dates d'import chez Radarr et Sonarr, et les listes « Reprendre » / « À suivre » de chaque compte.
 *
 * Coût mesuré le 09/11/2026 (920 films, 9 398 épisodes, 193 séries Sonarr) : Jellyfin en quatre appels
 * (listes gardées chaudes pour les films et les séries, les épisodes par pages de 500), Radarr en un
 * (gardé chaud), Sonarr en deux par série (épisodes et fichiers), quatre à la fois — relus toutes les
 * six heures seulement. Le palier 1 : deux appels par compte et un par série en cours, toutes les dix minutes.
 */

const ticksToS = (ticks: number | null | undefined) => (typeof ticks === "number" && ticks > 0 ? ticks / 10_000_000 : 0);
const dateMs = (s: string | null | undefined): number | null => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) && t > 0 ? t : null;
};

/** Toute la bibliothèque, films et épisodes, avec date d'import et genre. */
export async function readLibrary(): Promise<LibraryEntry[]> {
  const [movies, series, radarrMovies, sonarrSeries, episodes] = await Promise.all([
    cachedJellyfinMoviesAdmin(),
    cachedJellyfinSeriesAdmin(),
    cachedMovies().catch(() => []),
    cachedSeries().catch(() => []),
    // Toute la bibliothèque : `sinceMs = 0` lit chaque page (`getRecentEpisodesAdmin`, bornée à 20 000).
    jellyfin.getRecentEpisodesAdmin(0),
  ]);

  const radarrByTmdb = new Map(radarrMovies.filter((m) => m.movieFile).map((m) => [m.tmdbId, m]));
  const out: LibraryEntry[] = [];
  for (const movie of movies) {
    if (!isJellyfinId(movie.Id)) continue;
    const tmdbId = Number(getProviderIdCI(movie.ProviderIds as Record<string, string> | undefined, "Tmdb"));
    const radarr = Number.isInteger(tmdbId) && tmdbId > 0 ? radarrByTmdb.get(tmdbId) : undefined;
    out.push({
      itemId: movie.Id.toLowerCase(),
      kind: "Movie",
      title: movie.ProductionYear ? `${movie.Name} (${movie.ProductionYear})` : movie.Name,
      seriesId: null,
      durationS: ticksToS(movie.RunTimeTicks),
      importedAt: dateMs(radarr?.movieFile?.dateAdded),
      createdAt: dateMs(movie.DateCreated),
      animation: isAnimationGenre(movie.Genres) || isAnimationGenre(radarr?.genres),
    });
  }

  // Les séries de Jellyfin rapprochées de Sonarr par TVDB, sinon TMDB.
  const sonarrByTvdb = new Map(sonarrSeries.map((s) => [s.tvdbId, s]));
  const sonarrByTmdb = new Map(sonarrSeries.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s]));
  const seriesInfo = new Map<string, { name: string; animation: boolean; sonarrId: number | null }>();
  for (const s of series) {
    const ids = s.ProviderIds as Record<string, string> | undefined;
    const tvdb = Number(getProviderIdCI(ids, "Tvdb"));
    const tmdb = Number(getProviderIdCI(ids, "Tmdb"));
    const match = (tvdb > 0 ? sonarrByTvdb.get(tvdb) : undefined) ?? (tmdb > 0 ? sonarrByTmdb.get(tmdb) : undefined);
    seriesInfo.set(s.Id.toLowerCase(), { name: s.Name, animation: isAnimationGenre(s.Genres) || isAnimationGenre(match?.genres), sonarrId: match?.id ?? null });
  }

  // Les dates d'import des épisodes : celle du fichier que Sonarr a rattaché à chaque épisode.
  const wanted = [...new Set([...seriesInfo.values()].map((s) => s.sonarrId).filter((id): id is number => id !== null))];
  const importDates = new Map<number, Map<string, number>>();
  await mapInBatches(wanted, 4, async (sonarrId) => {
    try {
      const [eps, files] = await Promise.all([sonarr.getEpisodes(sonarrId), sonarr.getEpisodeFiles(sonarrId)]);
      const fileDate = new Map(files.map((f) => [f.id, dateMs(f.dateAdded)]));
      const byNumber = new Map<string, number>();
      for (const e of eps) {
        const at = e.episodeFileId ? fileDate.get(e.episodeFileId) : null;
        if (at) byNumber.set(`${e.seasonNumber}:${e.episodeNumber}`, at);
      }
      importDates.set(sonarrId, byNumber);
    } catch {
      // Une série que Sonarr ne rend pas : ses épisodes gardent la date de Jellyfin.
    }
  });

  let n = 0;
  for (const ep of episodes as JellyfinItem[]) {
    if (++n % 1000 === 0) await yieldToLoop();
    if (!isJellyfinId(ep.Id) || (ep as { LocationType?: string }).LocationType === "Virtual") continue;
    const sid = ep.SeriesId?.toLowerCase() ?? null;
    const info = sid ? seriesInfo.get(sid) : undefined;
    const season = ep.ParentIndexNumber;
    const number = ep.IndexNumber;
    const imported = info?.sonarrId != null && season != null && number != null ? (importDates.get(info.sonarrId)?.get(`${season}:${number}`) ?? null) : null;
    const code = season != null && number != null ? ` S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}` : "";
    out.push({
      itemId: ep.Id.toLowerCase(),
      kind: "Episode",
      title: `${ep.SeriesName ?? info?.name ?? ""}${code}`.trim() || ep.Name,
      seriesId: sid,
      durationS: ticksToS(ep.RunTimeTicks),
      importedAt: imported,
      createdAt: dateMs(ep.DateCreated),
      animation: info?.animation ?? false,
    });
  }
  return out;
}

/**
 * Le palier 1 : pour chaque compte, « Reprendre » puis « À suivre », et les épisodes de chaque série
 * en cours. Les comptes des liens de partage n'en sont pas (`getUsers` les retire).
 */
export async function readWatching(): Promise<Map<string, number>> {
  const users = await jellyfin.getUsers();
  const lists = await mapInBatches(users, 3, async (user) => {
    const [resume, nextUp] = await Promise.all([
      jellyfin.getResumeItems(user.Id).then((r) => r.Items ?? []).catch(() => [] as JellyfinItem[]),
      jellyfin.getNextUpGlobal(user.Id, 10).catch(() => [] as JellyfinItem[]),
    ]);
    const list: WatchingEntry[] = [];
    for (const item of [...resume, ...nextUp]) {
      if (!isJellyfinId(item.Id)) continue;
      if (item.Type === "Movie") list.push({ itemId: item.Id.toLowerCase(), kind: "Movie", seriesId: null });
      else if (item.Type === "Episode") list.push({ itemId: item.Id.toLowerCase(), kind: "Episode", seriesId: item.SeriesId?.toLowerCase() ?? null });
    }
    return list;
  });
  const seriesIds = [...new Set(lists.flat().flatMap((e) => (e.seriesId && isJellyfinId(e.seriesId) ? [e.seriesId] : [])))];
  const chains = new Map<string, EpisodeRef[]>();
  await mapInBatches(seriesIds, 4, async (sid) => {
    const eps = await jellyfin.getEpisodesAdmin(sid).catch(() => [] as JellyfinItem[]);
    chains.set(
      sid,
      eps.map((e) => ({ Id: e.Id.toLowerCase(), ParentIndexNumber: e.ParentIndexNumber, IndexNumber: e.IndexNumber })),
    );
  });
  return watchingRanks(lists, (sid) => chains.get(sid));
}

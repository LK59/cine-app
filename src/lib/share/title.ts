import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import {
  cachedMovies,
  cachedSeries,
  cachedJellyfinMoviesAdmin,
  cachedJellyfinSeriesAdmin,
  cachedJellyfinFirstEpisodes,
  cachedJellyfinSeasons,
  cachedJellyfinRecentEpisodes,
} from "@/lib/server-cache";
import { jellyfinOnlyMovies, jellyfinOnlySeries, matchMovies, matchSeries } from "@/lib/catalogueMembers";
import { jellyfinOnlyCinemaMovie, jellyfinOnlyCinemaSeries } from "@/lib/jellyfinOnlyCatalogue";
import { toCinemaMovie, toCinemaSeries } from "@/lib/cinemaEntries";
import { latestArrivals, seriesFreshness } from "@/lib/seriesArrival";
import type { Locale } from "@/lib/i18n";
import type { Share } from "@/lib/share/store";

/**
 * La carte du titre d'un lien de partage (DECISIONS.md §112) — celle que le catalogue sert pour ce
 * titre, construite par les mêmes fonctions (`cinemaEntries.ts`) sur les mêmes listes gardées au
 * chaud (`catalogueWarm.ts`) : la fiche de l'invité lit exactement ce que lirait celle du foyer.
 *
 * Une seule carte est construite, celle dont l'élément Jellyfin est le titre du lien ; aucune autre
 * ne quitte cette fonction. Le rapprochement est celui du catalogue (`matchMovies`/`matchSeries`,
 * puis ce que Jellyfin a seul, §89) : un titre que le catalogue ne montrerait pas n'a pas de carte
 * ici non plus, et la page le dit (`null`).
 *
 * Deux écarts, voulus. Les tags bloqués (§54) ne s'appliquent pas : c'est l'administrateur qui a
 * choisi ce titre pour ce lien. Et la date d'une série (§75) ne lit pas ce que le compte du lien a
 * vu : elle ne sert qu'aux badges et aux rangées, que la page d'un lien n'a pas — une question de
 * moins à Jellyfin à chaque ouverture.
 */
export async function shareTitleEntry(share: Pick<Share, "kind" | "itemId">, locale: Locale): Promise<CinemaMovie | CinemaSeries | null> {
  const wanted = share.itemId.toLowerCase();
  const isWanted = (id: string) => id.toLowerCase() === wanted;

  if (share.kind === "movie") {
    const [movies, jellyfinMovies] = await Promise.all([cachedMovies(), cachedJellyfinMoviesAdmin()]);
    const matched = matchMovies(movies, jellyfinMovies);
    const hit = matched.find((x) => isWanted(x.jfItem.Id));
    if (hit) return toCinemaMovie(hit.m, hit.jfItem.Id, locale);
    // Les identifiants réservés dépendent de toute la liste (`withReservedIds`) : calculée en entier,
    // comme le catalogue, pour que la carte porte le même `radarrId` que chez le foyer.
    const only = jellyfinOnlyMovies(jellyfinMovies, matched).find((t) => isWanted(t.item.Id));
    return only ? jellyfinOnlyCinemaMovie(only, locale) : null;
  }

  const [series, jellyfinSeries, firstEpisodes, seasons, recentEpisodes] = await Promise.all([
    cachedSeries(),
    cachedJellyfinSeriesAdmin(),
    // Les mêmes ornements que le catalogue, et la même tolérance : sans eux, la fiche attend sa liste.
    cachedJellyfinFirstEpisodes().catch(() => []),
    cachedJellyfinSeasons().catch(() => []),
    cachedJellyfinRecentEpisodes().catch(() => []),
  ]);
  const matched = matchSeries(series, jellyfinSeries);
  const hit = matched.find((x) => isWanted(x.jfItem.Id));
  const only = hit ? null : ((await jellyfinOnlySeries(jellyfinSeries, matched).catch(() => [])).find((t) => isWanted(t.item.Id)) ?? null);
  const jfItem = hit?.jfItem ?? only?.item;
  if (!jfItem) return null;

  // Le premier épisode et le nombre de saisons non vides : la règle de la route des séries.
  const first = firstEpisodes.find((ep) => ep.SeriesId === jfItem.Id);
  const firstEpisode = first ? { itemId: first.Id, runtimeTicks: first.RunTimeTicks ?? null } : undefined;
  const seasonNumbers = new Set<number>();
  for (const season of seasons) {
    if (season.SeriesId !== jfItem.Id || (season.ChildCount ?? 1) <= 0) continue;
    seasonNumbers.add(season.IndexNumber ?? -1);
  }
  const freshness = seriesFreshness({
    sonarrAddedAt: hit?.s.added ?? null,
    libraryAddedAt: jfItem.DateCreated,
    latest: latestArrivals(recentEpisodes).get(jfItem.Id),
    seenLatest: false,
  });
  if (hit) return toCinemaSeries(hit.s, hit.jfItem, locale, firstEpisode, seasonNumbers.size || undefined, freshness);
  return jellyfinOnlyCinemaSeries(only!, locale, firstEpisode, seasonNumbers.size || undefined, freshness);
}

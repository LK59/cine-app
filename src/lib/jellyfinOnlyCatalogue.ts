import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { JellyfinOnlyTitle } from "@/lib/catalogueMembers";
import { canonicalGenres } from "@/lib/genres";
import { cataloguePoster, seriesBackdrop } from "@/lib/images";
import { getImdbRating } from "@/lib/imdb-rating";
import type { Locale } from "@/lib/i18n";
import { getTitleArt, logoForLocale } from "@/lib/title-art";
import { tvEpisodeRuntime } from "@/lib/tvRuntime";
import { catalogueExtras, getTitleExtras, getTitleNames, getTitleOverviews, localizedOverview, localizedTitle } from "@/lib/titleNames";

/**
 * La carte d'un titre que Jellyfin a seul (DECISIONS.md §89) — même forme que celles de Radarr et
 * Sonarr, pour qu'aucun écran n'ait à les distinguer, sauf là où la gestion entre en jeu (`source`).
 *
 * Ses métadonnées passent par le TMDB que Jellyfin lui donne — titre et synopsis traduits, logo,
 * accroche, bande-annonce, distribution : les mêmes caches que le reste du catalogue —, et à défaut
 * par les champs de Jellyfin lui-même (nom, synopsis, genres, date d'entrée). L'affiche et le grand
 * visuel sont ceux de Jellyfin quand TMDB n'en donne pas dans la langue de qui regarde.
 */

const minutesOf = (ticks: number | undefined): number | null => (ticks && ticks > 0 ? Math.max(1, Math.round(ticks / 10_000_000 / 60)) : null);

export async function jellyfinOnlyCinemaMovie(t: JellyfinOnlyTitle, locale: Locale): Promise<CinemaMovie> {
  const { item, tmdbId } = t;
  const [art, imdbRating] = await Promise.all([
    getTitleArt(tmdbId ?? 0, "movie"),
    tmdbId ? getImdbRating(tmdbId, "movie").catch(() => null) : Promise.resolve(null),
  ]);
  const names = getTitleNames(tmdbId, "movie");
  const { title, aka } = localizedTitle(names, locale, item.Name);
  const original = item.OriginalTitle?.trim();
  return {
    radarrId: t.id,
    source: "jellyfin",
    runtimeMinutes: minutesOf(item.RunTimeTicks),
    jellyfinItemId: item.Id,
    tmdbId: tmdbId ?? 0,
    title,
    ...(aka ? { aka } : {}),
    ...(original && original !== title && original !== aka ? { originalTitle: original } : {}),
    year: item.ProductionYear ?? 0,
    posterUrl: cataloguePoster("movie", art.posterByLang, undefined, locale, item),
    backdropUrl: seriesBackdrop(item, undefined),
    logoUrl: logoForLocale(art, names, locale),
    posterTextlessUrl: art.posterTextlessUrl,
    overview: localizedOverview(getTitleOverviews(tmdbId, "movie"), locale, item.Overview?.trim() || null),
    ...catalogueExtras(getTitleExtras(tmdbId, "movie"), locale),
    imdbRating,
    genres: canonicalGenres(item.Genres),
    addedAt: item.DateCreated ?? null,
  };
}

export async function jellyfinOnlyCinemaSeries(
  t: JellyfinOnlyTitle,
  locale: Locale,
  firstEpisode: CinemaSeries["firstEpisode"],
  seasonCount: number | undefined,
  freshness: Pick<CinemaSeries, "addedAt" | "arrival">
): Promise<CinemaSeries> {
  const { item, tmdbId } = t;
  const [art, imdbRating] = await Promise.all([
    getTitleArt(tmdbId ?? 0, "series"),
    tmdbId ? getImdbRating(tmdbId, "series").catch(() => null) : Promise.resolve(null),
  ]);
  const names = getTitleNames(tmdbId, "series");
  const { title, aka } = localizedTitle(names, locale, item.Name);
  const extras = getTitleExtras(tmdbId, "series");
  return {
    sonarrId: t.id,
    source: "jellyfin",
    jellyfinItemId: item.Id,
    tvdbId: t.tvdbId ?? 0,
    tmdbId,
    title,
    ...(aka ? { aka } : {}),
    year: item.ProductionYear ?? 0,
    posterUrl: cataloguePoster("series", art.posterByLang, undefined, locale, item),
    backdropUrl: seriesBackdrop(item, undefined),
    logoUrl: logoForLocale(art, names, locale),
    posterTextlessUrl: art.posterTextlessUrl,
    overview: localizedOverview(getTitleOverviews(tmdbId, "series"), locale, item.Overview?.trim() || null),
    // La même règle que la route des séries (`tvEpisodeRuntime`), sans durée Sonarr : celle de Jellyfin
    // n'est pas celle d'un épisode.
    ...(extras ? { ...catalogueExtras(extras, locale), episodeRuntime: tvEpisodeRuntime(extras.tvRuntime ?? null, null) } : {}),
    imdbRating,
    genres: canonicalGenres(item.Genres),
    addedAt: freshness.addedAt,
    ...(freshness.arrival ? { arrival: freshness.arrival } : {}),
    ...(firstEpisode ? { firstEpisode } : {}),
    ...(seasonCount ? { seasonCount } : {}),
  };
}

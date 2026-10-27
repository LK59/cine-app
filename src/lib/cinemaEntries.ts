import { canonicalGenres } from "@/lib/genres";
import { backdropUrl, tmdbResize, cataloguePoster, seriesBackdrop } from "@/lib/images";
import type { Locale } from "@/lib/i18n";
import { getTitleArt, logoForScreen } from "@/lib/title-art";
import { catalogueExtras, getTitleExtras, type TitleExtras, getTitleNames, getTitleOverviews, localizedOverview, localizedTitle } from "@/lib/titleNames";
import { getImdbRating } from "@/lib/imdb-rating";
import { tvEpisodeRuntime } from "@/lib/tvRuntime";
import { toDynamicRange, type VideoQuality } from "@/lib/videoQuality";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

/**
 * La carte d'un titre de Radarr ou de Sonarr, telle que le catalogue la sert — écrite ici une fois
 * pour les deux catalogues et pour la page d'un lien de partage (`/api/share/title`, DECISIONS.md
 * §112), qui sert la même carte pour un seul titre. Déplacée telle quelle depuis les deux routes
 * (20/10/2026) : une seconde écriture pour le lien aurait dérivé de la première, et la fiche de
 * l'invité aurait cessé de ressembler à celle du foyer sans que rien ne le dise.
 */

// Bulk-included here (like poster/backdrop already were) rather than fetched per-item on focus
// — Cinema Mode's whole hero/detail idea is an instant title treatment, not a spinner-then-swap.
// getTitleLogo() is persistently cached 7 days per title (same cache the per-item
// /api/radarr/movies/[id]/info route already populates), so only the very first request after a
// cold cache pays the full TMDB round-trip for the whole library at once — every request after
// that, including this one, is cache reads only.
export async function toCinemaMovie(m: RadarrMovie, jellyfinItemId: string, locale: Locale): Promise<CinemaMovie> {
  // Le logo et l'affiche sans texte viennent de la même réponse TMDB et de la même entrée de
  // cache : la seconde ne coûte donc pas un appel de plus.
  const art = await getTitleArt(m.tmdbId, "movie");
  const names = getTitleNames(m.tmdbId, "movie");
  const { title, aka } = localizedTitle(names, locale, m.title);
  return {
    radarrId: m.id,
    runtimeMinutes: m.runtime && m.runtime > 0 ? m.runtime : null,
    jellyfinItemId,
    tmdbId: m.tmdbId,
    title,
    ...(aka ? { aka } : {}),
    ...(m.originalTitle && m.originalTitle !== title && m.originalTitle !== aka ? { originalTitle: m.originalTitle } : {}),
    year: m.year,
    // L'affiche dans la langue de qui regarde, celle de Radarr sinon. Voir `libraryPoster`.
    posterUrl: cataloguePoster("movie", art.posterByLang, m.images, locale),
    backdropUrl: tmdbResize(backdropUrl(m.images, "full"), "w1280"),
    // Le logo de la langue du titre affiché — voir `logoForLocale` (DECISIONS.md §58).
    logoUrl: logoForScreen(art, names, locale),
    posterTextlessUrl: art.posterTextlessUrl,
    // Dans la langue de qui regarde quand TMDB la connaît — voir `TitleOverviews`.
    overview: localizedOverview(getTitleOverviews(m.tmdbId, "movie"), locale, m.overview ?? null),
    // L'accroche et la bande-annonce, là dès l'ouverture de la fiche — voir `TitleExtras`.
    ...catalogueExtras(getTitleExtras(m.tmdbId, "movie"), locale),
    // Radarr already resolves this itself at add/refresh time (Skyhook) — free, no
    // OMDb/TMDB round trip needed, same field fetchHero() in the dashboard route uses.
    imdbRating: m.ratings?.imdb?.value != null ? m.ratings.imdb.value.toFixed(1) : null,
    quality: videoQualityOf(m),
    // Sous leur nom commun : « Horreur » et « Horror » ne font qu'un genre — voir `genres.ts`.
    genres: canonicalGenres(m.genres),
    addedAt: m.added ?? null,
  };
}

/**
 * Ce que Radarr sait du fichier, réduit à ce qui s'affiche.
 *
 * `undefined` plutôt qu'un objet vide quand il n'y a rien à dire : c'est ce qui fait qu'un film
 * sans information ne pèse pas une clé de plus dans la charge utile.
 */
function videoQualityOf(m: RadarrMovie): VideoQuality | undefined {
  const resolution = m.movieFile?.quality?.quality?.resolution;
  const dynamicRange = toDynamicRange(m.movieFile?.mediaInfo?.videoDynamicRangeType);
  if (!resolution && !dynamicRange) return undefined;
  return {
    ...(resolution ? { resolution } : {}),
    ...(dynamicRange ? { dynamicRange } : {}),
  };
}


// Mirrors /api/cinema/movies/route.ts exactly (see its own comments for the reasoning behind
// each choice — bulk-included logo/rating, jellyfin-match-required filtering, genre rows +
// spotlight) — the one real difference is IMDb rating: Radarr resolves that for movies itself
// (Skyhook, free), but Sonarr doesn't for series, hence the extra getImdbRating() call here
// (OMDb-backed, 24h persistently cached — same helper the dashboard route already uses for its
// own "recently added series" rail).
/**
 * L'accroche, la bande-annonce et la durée d'un épisode (« 43min/ép. ») : la même règle que la
 * fiche (`tvEpisodeRuntime`), la durée de Sonarr comprise. Absentes ensemble tant que TMDB n'a pas
 * répondu pour ce titre.
 */
function seriesExtras(extras: TitleExtras | null, locale: Locale, sonarrRuntime: number | null | undefined) {
  if (!extras) return {};
  return { ...catalogueExtras(extras, locale), episodeRuntime: tvEpisodeRuntime(extras.tvRuntime ?? null, sonarrRuntime) };
}

export async function toCinemaSeries(
  s: SonarrSeries,
  jellyfinItem: { Id: string; BackdropImageTags?: string[]; ImageTags?: { Primary?: string } },
  locale: Locale,
  firstEpisode: CinemaSeries["firstEpisode"],
  seasonCount: number | undefined,
  freshness: Pick<CinemaSeries, "addedAt" | "arrival">
): Promise<CinemaSeries> {
  // Independent lookups (different upstreams, different cache keys) — run concurrently rather
  // than one after the other, halving the cold-cache latency per series that hasn't been seen
  // by either cache before (steady state is unaffected either way, both are cache reads then).
  const [art, imdbRating] = await Promise.all([
    getTitleArt(s.tmdbId ?? 0, "series"),
    s.tmdbId ? getImdbRating(s.tmdbId, "series") : Promise.resolve(null),
  ]);
  const names = getTitleNames(s.tmdbId, "series");
  const { title, aka } = localizedTitle(names, locale, s.title);
  return {
    sonarrId: s.id,
    jellyfinItemId: jellyfinItem.Id,
    tvdbId: s.tvdbId,
    tmdbId: s.tmdbId ?? null,
    title,
    ...(aka ? { aka } : {}),
    year: s.year,
    // La langue de qui regarde, celle de Jellyfin sinon, celle de Sonarr en dernier — voir `jellyfinPoster`.
    posterUrl: cataloguePoster("series", art.posterByLang, s.images, locale, jellyfinItem),
    // Redimensionné par Jellyfin plutôt que l'original de TheTVDB — voir `seriesBackdrop`.
    backdropUrl: seriesBackdrop(jellyfinItem, s.images),
    // Le logo de la langue du titre affiché — voir `logoForLocale` (DECISIONS.md §58).
    logoUrl: logoForScreen(art, names, locale),
    posterTextlessUrl: art.posterTextlessUrl,
    // Dans la langue de qui regarde quand TMDB la connaît — voir `TitleOverviews`.
    overview: localizedOverview(getTitleOverviews(s.tmdbId, "series"), locale, s.overview ?? null),
    // L'accroche et la bande-annonce, là dès l'ouverture de la fiche — voir `TitleExtras`.
    ...seriesExtras(getTitleExtras(s.tmdbId, "series"), locale, s.runtime),
    imdbRating,
    // Sous leur nom commun : « Horreur » et « Horror » ne font qu'un genre — voir `genres.ts`.
    genres: canonicalGenres(s.genres),
    addedAt: freshness.addedAt,
    ...(freshness.arrival ? { arrival: freshness.arrival } : {}),
    ...(firstEpisode ? { firstEpisode } : {}),
    ...(seasonCount ? { seasonCount } : {}),
  };
}


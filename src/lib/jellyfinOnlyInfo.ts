import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { blockedTagsOf, carriesBlockedTag } from "@/lib/blockedTags";
import { jellyfinOnlyTitle } from "@/lib/catalogueMembers";
import { createTmdbClient, pickTrailer } from "@/lib/clients/tmdb";
import { getTmdbLocale, localeOf } from "@/lib/i18n";
import { isJellyfinOnlyId } from "@/lib/jellyfinOnlyId";
import { verifySessionFull } from "@/lib/session";
import { getTitleLogoFor } from "@/lib/title-logo";
import { cachedOmdbRating, cachedTmdbMovieInfo, cachedTmdbTvInfo } from "@/lib/titleInfoCache";
import { movieTmdbFacts, seriesTmdbFacts } from "@/lib/titleInfoShape";

/**
 * La description de fiche d'un titre que Jellyfin a seul (DECISIONS.md §89), servie aux mêmes
 * adresses que celles de Radarr et Sonarr — les fiches ne savent pas d'où vient un titre, et n'ont
 * pas à le savoir.
 *
 * Même forme, autre source : TMDB par l'identifiant que Jellyfin donne, OMDb par son IMDb. **Rien de
 * la gestion** : ni sous-titres Bazarr, ni téléchargement en cours — aucun de ces services ne connaît
 * le titre, et leur demander par un identifiant réservé interrogerait un autre titre ou rien.
 *
 * `null` quand l'identifiant n'est pas de la plage réservée : la route continue comme avant.
 */
export async function jellyfinOnlyInfo(req: NextRequest, type: "movie" | "series", id: number): Promise<NextResponse | null> {
  if (!isJellyfinOnlyId(id)) return null;
  const notFound = () => NextResponse.json({ error: type === "movie" ? "Film introuvable" : "Série introuvable" }, { status: 404 });
  const title = await jellyfinOnlyTitle(type, id).catch(() => null);
  if (!title) return notFound();

  // Caché par les tags bloqués du compte : il n'existe pas pour lui (DECISIONS.md §54). La règle de
  // Jellyfin, sur l'élément lui-même — un titre sans TMDB n'a pas d'autre nom.
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (session && session.role !== "admin" && session.jfId) {
    if (carriesBlockedTag(title.item.Tags, await blockedTagsOf(session.jfId))) return notFound();
  }

  const lang = getTmdbLocale(req.cookies.get("cine-lang")?.value);
  const tmdb = createTmdbClient(lang);
  const tmdbId = tmdb.isEnabled() ? title.tmdbId : null;
  const [tmdbPart, rating, logoUrl] = await Promise.all([
    tmdbId ? (type === "movie" ? cachedTmdbMovieInfo(tmdb, lang, tmdbId) : cachedTmdbTvInfo(tmdb, lang, tmdbId)).catch(() => null) : Promise.resolve(null),
    title.imdbId ? cachedOmdbRating(title.imdbId).catch(() => null) : Promise.resolve(null),
    title.tmdbId ? getTitleLogoFor(title.tmdbId, type, localeOf(req)).catch(() => null) : Promise.resolve(null),
  ]);
  const trailer = pickTrailer(tmdbPart?.videos?.results ?? []);
  const common = {
    logoUrl,
    trailerKey: trailer?.key ?? null,
    imdbId: title.imdbId,
    imdbRating: rating && rating.Response === "True" ? rating.imdbRating : null,
    imdbVotes: rating && rating.Response === "True" ? rating.imdbVotes : null,
  };
  if (type === "movie") {
    const details = tmdbPart?.details as Parameters<typeof movieTmdbFacts>[0] | undefined;
    return NextResponse.json({ ...common, tmdb: details ? movieTmdbFacts(details) : null, subtitles: [], audioLanguages: [], activeDownload: null });
  }
  const details = tmdbPart?.details as Parameters<typeof seriesTmdbFacts>[0] | undefined;
  return NextResponse.json({ ...common, tmdb: details ? seriesTmdbFacts(details, null) : null, episodeSubtitles: [], activeDownloads: [] });
}

import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { bazarr } from "@/lib/clients/bazarr";
import { createTmdbClient, pickTrailer } from "@/lib/clients/tmdb";
import { movieTmdbFacts } from "@/lib/titleInfoShape";
import { jellyfinOnlyInfo } from "@/lib/jellyfinOnlyInfo";
import { getTmdbLocale, localeOf } from "@/lib/i18n";
import { cachedOmdbRating, cachedRadarrQueue, cachedTmdbMovieInfo, hiddenFromCaller } from "@/lib/titleInfoCache";
import { getTitleLogoFor } from "@/lib/title-logo";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const lang = getTmdbLocale(req.cookies.get("cine-lang")?.value);
  const tmdb = createTmdbClient(lang);
  const id = Number(params.id);
  // Un film que Jellyfin a seul (DECISIONS.md §89) : rien à demander à Radarr ni à Bazarr.
  const onlyInJellyfin = await jellyfinOnlyInfo(req, "movie", id);
  if (onlyInJellyfin) return onlyInJellyfin;
  const movie = await radarr.getMovie(id).catch(() => null);
  if (!movie) return NextResponse.json({ error: "Film introuvable" }, { status: 404 });
  // Caché par les tags bloqués du compte : il n'existe pas pour lui (DECISIONS.md §54).
  if (movie.tmdbId && (await hiddenFromCaller(req, `movie:${movie.tmdbId}`))) {
    return NextResponse.json({ error: "Film introuvable" }, { status: 404 });
  }

  // Les parties stables passent par le cache — voir `titleInfoCache.ts`.
  const [tmdbPart, rating, subtitles, queue, logoUrl] = await Promise.all([
    tmdb.isEnabled() && movie.tmdbId ? cachedTmdbMovieInfo(tmdb, lang, movie.tmdbId).catch(() => null) : Promise.resolve(null),
    movie.imdbId ? cachedOmdbRating(movie.imdbId).catch(() => null) : Promise.resolve(null),
    bazarr.getMovieDetails(id).catch(() => null),
    cachedRadarrQueue().catch(() => ({ records: [] as any[] })),
    // Le logo du film — la même image que le mode cinéma affiche déjà, mise en cache une
    // semaine. Fetché avec le reste plutôt qu'après : il est en tête de page, c'est la première
    // chose qu'on voit, et il n'a aucune raison d'arriver en dernier.
    movie.tmdbId ? getTitleLogoFor(movie.tmdbId, "movie", localeOf(req)) : Promise.resolve(null),
  ]);

  const tmdbInfo = tmdbPart?.details ?? null;
  const tmdbVideos = tmdbPart?.videos ?? { results: [] };
  const activeDownload = queue.records.find((r: any) => r.movieId === id || r.movie?.id === id) ?? null;

  const trailer = pickTrailer(tmdbVideos.results);

  return NextResponse.json({
    tmdb: tmdbInfo ? movieTmdbFacts(tmdbInfo) : null,
    logoUrl,
    trailerKey: trailer?.key ?? null,
    // Pour les notes critiques de la fenêtre « Voir plus » (MDBList) — voir `CinemaRatingsLine`.
    imdbId: movie.imdbId || null,
    imdbRating: rating && rating.Response === "True" ? rating.imdbRating : null,
    imdbVotes: rating && rating.Response === "True" ? rating.imdbVotes : null,
    subtitles: subtitles?.subtitles ?? [],
    audioLanguages: subtitles?.audio_language ?? [],
    activeDownload: activeDownload
      ? {
          title: activeDownload.title,
          status: activeDownload.status,
          trackedDownloadStatus: activeDownload.trackedDownloadStatus,
          size: activeDownload.size,
          sizeleft: activeDownload.sizeleft,
          indexer: activeDownload.indexer,
        }
      : null,
  });
}

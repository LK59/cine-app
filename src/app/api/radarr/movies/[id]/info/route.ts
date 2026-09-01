import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { bazarr } from "@/lib/clients/bazarr";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { omdb } from "@/lib/clients/omdb";
import { getTitleLogo } from "@/lib/title-logo";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
  const id = Number(params.id);
  const movie = await radarr.getMovie(id).catch(() => null);
  if (!movie) return NextResponse.json({ error: "Film introuvable" }, { status: 404 });

  const [tmdbInfo, tmdbVideos, rating, subtitles, queue, logoUrl] = await Promise.all([
    tmdb.isEnabled() ? tmdb.getMovie(movie.tmdbId).catch(() => null) : Promise.resolve(null),
    tmdb.isEnabled() ? tmdb.getMovieVideos(movie.tmdbId).catch(() => ({ results: [] })) : Promise.resolve({ results: [] }),
    omdb.isEnabled() && movie.imdbId ? omdb.getRating(movie.imdbId).catch(() => null) : Promise.resolve(null),
    bazarr.getMovieDetails(id).catch(() => null),
    radarr.getQueue().catch(() => ({ records: [] as any[] })),
    getTitleLogo(movie.tmdbId, "movie"),
  ]);

  const activeDownload = queue.records.find((r: any) => r.movieId === id || r.movie?.id === id) ?? null;

  const trailer = tmdbVideos.results.find(
    (v) => v.type === "Trailer" && v.site === "YouTube" && v.official
  ) ?? tmdbVideos.results.find((v) => v.type === "Trailer" && v.site === "YouTube") ?? null;

  return NextResponse.json({
    tmdb: tmdbInfo
      ? {
          overview: tmdbInfo.overview,
          tagline: tmdbInfo.tagline,
          genres: tmdbInfo.genres?.map((g) => g.name) ?? [],
          runtime: tmdbInfo.runtime,
          backdropUrl: tmdbInfo.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${tmdbInfo.backdrop_path}` : null,
          cast: (tmdbInfo.credits?.cast ?? []).slice(0, 12).map((c) => ({
            tmdbId: c.id,
            name: c.name,
            character: c.character,
            photoUrl: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : null,
          })),
          collection: tmdbInfo.belongs_to_collection
            ? { id: tmdbInfo.belongs_to_collection.id, name: tmdbInfo.belongs_to_collection.name }
            : null,
        }
      : null,
    trailerKey: trailer?.key ?? null,
    logoUrl,
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

import { NextRequest, NextResponse } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { bazarr } from "@/lib/clients/bazarr";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { omdb } from "@/lib/clients/omdb";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
  const id = Number(params.id);
  const series = await sonarr.getSeriesById(id).catch(() => null);
  if (!series) return NextResponse.json({ error: "Série introuvable" }, { status: 404 });

  // Resolve TMDB TV id from TVDB first (needed for videos too)
  const tmdbTvId = tmdb.isEnabled()
    ? await tmdb.findTvByTvdbId(series.tvdbId).then((r) => r.tv_results[0]?.id ?? null).catch(() => null)
    : null;

  const [tmdbInfo, tmdbVideos, rating, episodeSubtitles, queue] = await Promise.all([
    tmdbTvId ? tmdb.getTv(tmdbTvId).catch(() => null) : Promise.resolve(null),
    tmdbTvId ? tmdb.getTvVideos(tmdbTvId).catch(() => ({ results: [] })) : Promise.resolve({ results: [] }),
    omdb.isEnabled() && series.imdbId ? omdb.getRating(series.imdbId).catch(() => null) : Promise.resolve(null),
    bazarr.getEpisodesDetails(id).catch(() => []),
    sonarr.getQueue().catch(() => ({ records: [] as any[] })),
  ]);

  const activeDownloads = queue.records.filter((r: any) => r.seriesId === id);

  const trailer = tmdbVideos.results.find(
    (v) => v.type === "Trailer" && v.site === "YouTube" && v.official
  ) ?? tmdbVideos.results.find((v) => v.type === "Trailer" && v.site === "YouTube") ?? null;

  return NextResponse.json({
    trailerKey: trailer?.key ?? null,
    tmdb: tmdbInfo
      ? {
          overview: tmdbInfo.overview,
          tagline: tmdbInfo.tagline,
          genres: tmdbInfo.genres?.map((g) => g.name) ?? [],
          runtime: tmdbInfo.episode_run_time?.[0] ?? null,
          backdropUrl: tmdbInfo.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${tmdbInfo.backdrop_path}` : null,
          cast: (tmdbInfo.credits?.cast ?? []).slice(0, 12).map((c) => ({
            tmdbId: c.id,
            name: c.name,
            character: c.character,
            photoUrl: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : null,
          })),
        }
      : null,
    imdbRating: rating && rating.Response === "True" ? rating.imdbRating : null,
    imdbVotes: rating && rating.Response === "True" ? rating.imdbVotes : null,
    episodeSubtitles,
    activeDownloads: activeDownloads.map((r: any) => ({
      episodeId: r.episodeId,
      title: r.title,
      status: r.status,
      trackedDownloadStatus: r.trackedDownloadStatus,
      size: r.size,
      sizeleft: r.sizeleft,
      indexer: r.indexer,
    })),
  });
}

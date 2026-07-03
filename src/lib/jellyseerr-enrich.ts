import { JellyseerrRequest } from "@/lib/clients/jellyseerr";
import { cachedMovies, cachedSeries, cachedMovieInfo, cachedTvInfo } from "@/lib/server-cache";

export type EnrichedRequest = JellyseerrRequest & { cinemaHref: string | null };

export async function enrichRequests(requests: JellyseerrRequest[]): Promise<EnrichedRequest[]> {
  const [movies, series] = await Promise.allSettled([cachedMovies(), cachedSeries()]);
  const movieByTmdb = new Map(
    movies.status === "fulfilled" ? movies.value.map((m) => [m.tmdbId, m.id]) : []
  );
  const seriesByTmdb = new Map(
    series.status === "fulfilled"
      ? series.value.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s.id])
      : []
  );

  // Deduplicate tmdbId calls — batch unique IDs, not one call per request
  const movieIds = new Set<number>();
  const tvIds = new Set<number>();
  for (const r of requests) {
    const tmdbId = r.media?.tmdbId;
    if (!tmdbId) continue;
    if ((r.media?.mediaType || r.type) === "movie") movieIds.add(tmdbId);
    else tvIds.add(tmdbId);
  }

  const [movieResults, tvResults] = await Promise.all([
    Promise.allSettled([...movieIds].map((id) => cachedMovieInfo(id).then((d) => ({ id, d })))),
    Promise.allSettled([...tvIds].map((id) => cachedTvInfo(id).then((d) => ({ id, d })))),
  ]);

  const movieData = new Map(
    movieResults.flatMap((r) => (r.status === "fulfilled" ? [[r.value.id, r.value.d]] : []))
  );
  const tvData = new Map(
    tvResults.flatMap((r) => (r.status === "fulfilled" ? [[r.value.id, r.value.d]] : []))
  );

  return requests.map((r): EnrichedRequest => {
    const tmdbId = r.media?.tmdbId;
    const mediaType = r.media?.mediaType || r.type;

    let cinemaHref: string | null = null;
    if (tmdbId) {
      if (mediaType === "movie") {
        const rid = movieByTmdb.get(tmdbId);
        if (rid) cinemaHref = `/radarr/${rid}`;
      } else {
        const sid = seriesByTmdb.get(tmdbId);
        if (sid) cinemaHref = `/sonarr/${sid}`;
      }
    }

    if (!tmdbId) return { ...r, cinemaHref };

    if (mediaType === "movie") {
      const d = movieData.get(tmdbId);
      return {
        ...r,
        media: { ...r.media, title: d?.title ?? r.media.title, posterPath: d?.posterPath ?? r.media.posterPath },
        cinemaHref,
      };
    } else {
      const d = tvData.get(tmdbId);
      return {
        ...r,
        media: { ...r.media, title: d?.name ?? r.media.title, posterPath: d?.posterPath ?? r.media.posterPath },
        cinemaHref,
      };
    }
  });
}

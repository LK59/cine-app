import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) {
    return NextResponse.json({ items: [] });
  }

  const [resumeData, movies, series] = await Promise.all([
    jellyfin.getResumeItems(session.jfId).catch(() => ({ Items: [] })),
    cachedMovies().catch(() => []),
    cachedSeries().catch(() => []),
  ]);

  const moviesByTmdb = new Map(movies.map((m) => [m.tmdbId, m.id]));
  const seriesByTvdb = new Map(series.map((s) => [s.tvdbId, s.id]));

  // Jellyfin never puts ProviderIds on Episode items, only on their parent
  // Series — fetch the series' TVDB id separately (deduped) so episodes in
  // the resume list can still link to their series' sheet.
  const episodeSeriesIds = [...new Set(
    resumeData.Items.filter((i) => i.Type === "Episode" && i.SeriesId).map((i) => i.SeriesId!)
  )];
  const seriesTvdbById = new Map<string, number | undefined>();
  await Promise.all(episodeSeriesIds.map(async (seriesId) => {
    const providerIds = await jellyfin.getItemProviderIds(session.jfId!, seriesId).catch(() => null);
    const tvdb = providerIds?.ProviderIds?.Tvdb;
    if (tvdb) seriesTvdbById.set(seriesId, parseInt(tvdb, 10));
  }));

  const items = resumeData.Items.map((item) => {
    const positionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
    const runtimeTicks = item.RunTimeTicks ?? 0;
    const progress = runtimeTicks > 0 ? Math.min((positionTicks / runtimeTicks) * 100, 99) : 0;

    let cinemaHref: string | null = null;
    if (item.Type === "Movie" && item.ProviderIds?.Tmdb) {
      const tmdbId = parseInt(item.ProviderIds.Tmdb, 10);
      const radarrId = moviesByTmdb.get(tmdbId);
      if (radarrId) cinemaHref = `/radarr/${radarrId}`;
    } else if (item.Type === "Series" && item.ProviderIds?.Tvdb) {
      const tvdbId = parseInt(item.ProviderIds.Tvdb, 10);
      const sonarrId = seriesByTvdb.get(tvdbId);
      if (sonarrId) cinemaHref = `/sonarr/${sonarrId}`;
    } else if (item.Type === "Episode" && item.SeriesId) {
      const tvdb = seriesTvdbById.get(item.SeriesId);
      const sonarrId = tvdb ? seriesByTvdb.get(tvdb) : undefined;
      if (sonarrId) cinemaHref = `/sonarr/${sonarrId}`;
    }

    return {
      id: item.Id,
      name: item.Type === "Episode" && item.SeriesName ? item.SeriesName : item.Name,
      subtitle:
        item.Type === "Episode"
          ? `S${String(item.ParentIndexNumber ?? 1).padStart(2, "0")}E${String(item.IndexNumber ?? 1).padStart(2, "0")} · ${item.Name}`
          : null,
      type: item.Type,
      progress: Math.round(progress),
      // Ticks as well as the percentage: Cinema Mode's Continue Watching cards resume playback
      // from the exact position and label themselves with the time remaining.
      positionTicks,
      runtimeTicks,
      imageTag: item.ImageTags?.Primary ?? null,
      cinemaHref,
    };
  });

  return NextResponse.json({ items });
}

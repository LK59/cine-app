import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { jellyfin } from "@/lib/clients/jellyfin";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
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

  const items = resumeData.Items.map((item) => {
    const positionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
    const runtimeTicks = item.RunTimeTicks ?? 0;
    const progress = runtimeTicks > 0 ? Math.min((positionTicks / runtimeTicks) * 100, 99) : 0;

    let cinemaHref: string | null = null;
    if (item.Type === "Movie" && item.ProviderIds?.Tmdb) {
      const tmdbId = parseInt(item.ProviderIds.Tmdb, 10);
      const radarrId = moviesByTmdb.get(tmdbId);
      if (radarrId) cinemaHref = `/radarr/${radarrId}`;
    } else if ((item.Type === "Episode" || item.Type === "Series") && item.ProviderIds?.Tvdb) {
      const tvdbId = parseInt(item.ProviderIds.Tvdb, 10);
      const sonarrId = seriesByTvdb.get(tvdbId);
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
      imageTag: item.ImageTags?.Primary ?? null,
      cinemaHref,
    };
  });

  return NextResponse.json({ items });
}

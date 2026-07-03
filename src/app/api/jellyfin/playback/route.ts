import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { jellyfin } from "@/lib/clients/jellyfin";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!session?.jfId) {
    return NextResponse.json({ error: "Jellyfin SSO requis" }, { status: 403 });
  }

  const userId = session.jfId;

  const [moviesPlayed, episodesPlayed, recentMovies, recentEpisodes] = await Promise.all([
    jellyfin.getPlayedCount(userId, "Movie").catch(() => ({ TotalRecordCount: 0 })),
    jellyfin.getPlayedCount(userId, "Episode").catch(() => ({ TotalRecordCount: 0 })),
    jellyfin.getRecentlyPlayed(userId, "Movie", 8).catch(() => ({ Items: [], TotalRecordCount: 0 })),
    jellyfin.getRecentlyPlayed(userId, "Episode", 8).catch(() => ({ Items: [], TotalRecordCount: 0 })),
  ]);

  return NextResponse.json({
    counts: {
      moviesPlayed: moviesPlayed.TotalRecordCount,
      episodesPlayed: episodesPlayed.TotalRecordCount,
    },
    recentMovies: recentMovies.Items.map((m) => ({
      id: m.Id,
      name: m.Name,
      lastPlayed: m.UserData?.LastPlayedDate ?? null,
      playCount: m.UserData?.PlayCount ?? 1,
      imageTag: m.ImageTags?.Primary ?? null,
      runtimeTicks: m.RunTimeTicks ?? 0,
    })),
    recentEpisodes: recentEpisodes.Items.map((e) => ({
      id: e.Id,
      name: e.Name,
      seriesName: e.SeriesName ?? null,
      season: e.ParentIndexNumber ?? null,
      episode: e.IndexNumber ?? null,
      lastPlayed: e.UserData?.LastPlayedDate ?? null,
      imageTag: e.ImageTags?.Primary ?? null,
      runtimeTicks: e.RunTimeTicks ?? 0,
    })),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";

export interface CinemaEpisode {
  jellyfinItemId: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview: string | null;
  thumbnailUrl: string | null;
  runtimeMinutes: number | null;
  watched: boolean;
  resumeTicks: number | null;
}

export interface CinemaSeason {
  seasonNumber: number;
  episodes: CinemaEpisode[];
}

export interface CinemaEpisodesPayload {
  seasons: CinemaSeason[];
  nextEpisode: {
    itemId: string;
    title: string;
    resumeTicks?: number;
    runtimeTicks?: number;
    seasonNumber: number;
    episodeNumber: number;
  } | null;
}

function toCinemaEpisode(item: import("@/lib/clients/jellyfin").JellyfinItem): CinemaEpisode {
  return {
    jellyfinItemId: item.Id,
    seasonNumber: item.ParentIndexNumber ?? 0,
    episodeNumber: item.IndexNumber ?? 0,
    title: item.Name,
    overview: item.Overview ?? null,
    thumbnailUrl: item.ImageTags?.Primary ? `/api/jellyfin/image?itemId=${item.Id}&tag=${item.ImageTags.Primary}` : null,
    runtimeMinutes: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10_000_000 / 60) : null,
    watched: item.UserData?.Played ?? false,
    resumeTicks: item.UserData?.PlaybackPositionTicks ?? null,
  };
}

// Takes the series' JELLYFIN item id directly (already known from the /api/cinema/series bulk
// payload) rather than a Sonarr id — Jellyfin's own episode list already carries everything
// this needs (title, overview, thumbnail, runtime, watched state, itemId to actually play), so
// there's no need to also fetch Sonarr's episode list and cross-reference by season/episode
// number the way the standard (non-Cinema) series detail page does; every episode Jellyfin
// returns here is by definition already downloaded and playable.
export async function GET(req: NextRequest, props: { params: Promise<{ jellyfinId: string }> }) {
  const { jellyfinId } = await props.params;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const [items, nextUp] = await Promise.all([
    jellyfin.getSeriesEpisodes(session.jfId, jellyfinId).catch(() => []),
    jellyfin.getNextUp(session.jfId, jellyfinId).catch(() => null),
  ]);

  const bySeasonNumber = new Map<number, CinemaEpisode[]>();
  for (const item of items) {
    const ep = toCinemaEpisode(item);
    (bySeasonNumber.get(ep.seasonNumber) ?? bySeasonNumber.set(ep.seasonNumber, []).get(ep.seasonNumber)!).push(ep);
  }
  for (const episodes of bySeasonNumber.values()) episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);

  // Season 0 (specials) sorts last, like Netflix/Jellyfin's own season pickers, not first —
  // everything else ascending.
  const seasons: CinemaSeason[] = [...bySeasonNumber.entries()]
    .sort(([a], [b]) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .map(([seasonNumber, episodes]) => ({ seasonNumber, episodes }));

  const payload: CinemaEpisodesPayload = {
    seasons,
    nextEpisode: nextUp
      ? {
          itemId: nextUp.Id,
          title: nextUp.Name,
          resumeTicks: nextUp.UserData?.PlaybackPositionTicks,
          runtimeTicks: nextUp.RunTimeTicks,
          seasonNumber: nextUp.ParentIndexNumber ?? 0,
          episodeNumber: nextUp.IndexNumber ?? 0,
        }
      : null,
  };
  return NextResponse.json(payload);
}

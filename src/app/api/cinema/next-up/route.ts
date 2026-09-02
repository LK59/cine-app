import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyfin, type JellyfinItem } from "@/lib/clients/jellyfin";

export interface CinemaNextUpItem {
  jellyfinItemId: string;
  title: string;
  thumbnailUrl: string | null;
  seasonNumber: number;
  episodeNumber: number;
  // null/0 => this series hasn't been started on this episode yet (the "Lire EpX SX" case,
  // Jellyfin's NextUp already resolves it to the right one — see the client's own doc comment).
  resumeTicks: number | null;
  runtimeTicks: number | null;
}

export interface CinemaNextUpPayload {
  items: CinemaNextUpItem[];
}

function toNextUpItem(item: JellyfinItem): CinemaNextUpItem {
  return {
    jellyfinItemId: item.Id,
    title: item.SeriesName ?? item.Name,
    thumbnailUrl: item.ImageTags?.Primary ? `/api/jellyfin/image?itemId=${item.Id}&tag=${item.ImageTags.Primary}` : null,
    seasonNumber: item.ParentIndexNumber ?? 0,
    episodeNumber: item.IndexNumber ?? 0,
    resumeTicks: item.UserData?.PlaybackPositionTicks ?? null,
    runtimeTicks: item.RunTimeTicks ?? null,
  };
}

// Series-side counterpart to the dashboard's own movie resume list (which Cinema Mode's Films
// tab already uses for its Continue Watching row) — powers the same row on the Séries tab.
// Jellyfin's global NextUp feed (see jellyfin.getNextUpGlobal's own doc comment) is used directly
// rather than cross-referenced against Sonarr, same reasoning as the episode-browser route: every
// item it returns is by definition already downloaded and playable.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) return NextResponse.json({ items: [] });

  const items = await jellyfin.getNextUpGlobal(session.jfId, 10).catch(() => []);
  const payload: CinemaNextUpPayload = { items: items.map(toNextUpItem) };
  return NextResponse.json(payload);
}

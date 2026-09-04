import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyfin, type JellyfinItem } from "@/lib/clients/jellyfin";
import { sonarr } from "@/lib/clients/sonarr";

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
  /** La série dans Sonarr, quand elle y est — c'est ce qui ouvre sa fiche depuis la reprise. */
  sonarrId: number | null;
}

export interface CinemaNextUpPayload {
  items: CinemaNextUpItem[];
}

function toNextUpItem(item: JellyfinItem, sonarrId: number | null): CinemaNextUpItem {
  return {
    jellyfinItemId: item.Id,
    title: item.SeriesName ?? item.Name,
    thumbnailUrl: item.ImageTags?.Primary ? `/api/jellyfin/image?itemId=${item.Id}&tag=${item.ImageTags.Primary}` : null,
    seasonNumber: item.ParentIndexNumber ?? 0,
    episodeNumber: item.IndexNumber ?? 0,
    resumeTicks: item.UserData?.PlaybackPositionTicks ?? null,
    runtimeTicks: item.RunTimeTicks ?? null,
    sonarrId,
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

  // La correspondance vers Sonarr passe par le TVDB de la série, comme le fait déjà la liste de
  // reprise des films avec le TMDB : une carte de reprise doit pouvoir ouvrir sa fiche, et non
  // seulement lancer la lecture.
  const seriesIds = [...new Set(items.map((i) => i.SeriesId).filter((id): id is string => !!id))];
  const tvdbBySeries = new Map<string, number>();
  await Promise.all(
    seriesIds.map(async (seriesId) => {
      const providerIds = await jellyfin.getItemProviderIds(session.jfId!, seriesId).catch(() => null);
      const tvdb = providerIds?.ProviderIds?.Tvdb;
      if (tvdb) tvdbBySeries.set(seriesId, parseInt(tvdb, 10));
    })
  );
  const sonarrByTvdb = new Map(
    (await sonarr.getSeries().catch(() => []))
      .filter((s) => s.tvdbId)
      .map((s) => [s.tvdbId, s.id] as const)
  );

  const payload: CinemaNextUpPayload = {
    items: items.map((item) => {
      const tvdb = item.SeriesId ? tvdbBySeries.get(item.SeriesId) : undefined;
      return toNextUpItem(item, (tvdb ? sonarrByTvdb.get(tvdb) : undefined) ?? null);
    }),
  };
  return NextResponse.json(payload);
}

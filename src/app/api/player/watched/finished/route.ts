import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { jellyfin } from "@/lib/clients/jellyfin";
import { watchedDb, watchlistDb } from "@/lib/db";
import { getProviderIdCI } from "@/lib/server-cache";
import { libraryIndex } from "@/lib/watched";

export const dynamic = "force-dynamic";

/**
 * Ce que la fin d'une lecture vient d'achever (DECISIONS.md §51), demandé par l'écran de fin du
 * lecteur : le film, ou la série si l'épisode était son dernier à voir. Le titre entre aussitôt
 * dans « Vus » (Jellyfin le marque de son côté au rapport d'arrêt, la synchronisation le recopiera
 * de toute façon), et la réponse dit s'il est encore dans « À voir » — l'écran propose alors de
 * l'en retirer, sans le faire d'office.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return NextResponse.json({ finished: false });
  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
  const userId = session.jfId ?? session.u;

  try {
    const item = await jellyfin.getItemBasic(session.jfId, itemId);
    let type: "movie" | "series";
    let tmdbId: number | null = null;
    let title = item.Name;
    let year = item.ProductionYear ?? null;

    if (item.Type === "Movie") {
      type = "movie";
      const raw = getProviderIdCI(item.ProviderIds as Record<string, string> | undefined, "tmdb");
      tmdbId = raw ? Number.parseInt(raw, 10) || null : null;
    } else if (item.Type === "Episode" && item.SeriesId) {
      type = "series";
      // Fini seulement si plus aucun autre épisode ne reste à voir : celui qui s'achève compte comme
      // vu, Jellyfin ne l'ayant peut-être pas encore enregistré.
      const episodes = await jellyfin.getSeriesEpisodes(session.jfId, item.SeriesId);
      const remaining = episodes.filter((e) => e.Id !== item.Id && !e.UserData?.Played);
      if (remaining.length > 0) return NextResponse.json({ finished: false });
      const series = (await libraryIndex())?.byJellyfinId.get(item.SeriesId);
      tmdbId = series?.type === "series" ? series.tmdbId : null;
      title = item.SeriesName ?? title;
      year = null;
    } else {
      return NextResponse.json({ finished: false });
    }
    if (!tmdbId) return NextResponse.json({ finished: false });

    const existing = watchedDb.get(userId, type, tmdbId);
    watchedDb.upsert({
      userId, mediaType: type, tmdbId, title: existing?.title || title, year: existing?.year ?? year, posterPath: existing?.posterPath ?? null,
      manual: existing?.manual ?? false, jfPresent: true, jfPlayed: true, watchedAt: Date.now(),
    });
    const inToWatch = watchlistDb.get(userId, type, tmdbId) !== null;
    return NextResponse.json({ finished: true, type, tmdbId, title, inToWatch });
  } catch {
    // L'écran de fin vit très bien sans cette question.
    return NextResponse.json({ finished: false });
  }
}

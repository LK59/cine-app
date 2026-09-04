import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { watchlistDb } from "@/lib/db";
import {
  cachedJellyfinMovies,
  cachedJellyfinSeries,
  cachedMovies,
  cachedSeries,
  getProviderIdCI,
} from "@/lib/server-cache";
import { getPlayerRequests, type PlayerRequest } from "@/lib/playerRequests";
import { withErrorHandling } from "@/lib/api-helpers";
import { config } from "@/lib/config";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

export const dynamic = "force-dynamic";

export interface PlayerListItem {
  tmdbId: number | null;
  type: "movie" | "series";
  title: string;
  year: number | null;
  poster: string | null;
  /** L'identifiant de la fiche cinéma quand le titre est dans la bibliothèque. */
  libraryId: number | null;
  /** Présent pour ce qui vient de Jellyfin — c'est ce qui permet de retirer d'un clic. */
  jellyfinId: string | null;
}

export interface PlayerListsPayload {
  requests: PlayerRequest[];
  toWatch: PlayerListItem[];
  watched: PlayerListItem[];
  abandoned: PlayerListItem[];
  favorites: PlayerListItem[];
}

/**
 * « Ma liste », ses cinq segments, en une réponse.
 *
 * Le principe qui gouverne tout ce fichier : **chaque liste est lue là où vit sa vérité.**
 *
 *   - À voir et Abandonné sont des intentions et des jugements. Rien d'autre ne les connaît :
 *     base locale.
 *   - Vu et Favoris appartiennent au compte Jellyfin, qui les tient déjà pour ses propres
 *     applications. Les recopier ici créerait une seconde version de la même information, et
 *     deux versions finissent toujours par diverger.
 *   - Les demandes appartiennent à Jellyseerr. On les lit, on ne les stocke pas.
 *
 * Le coût de cette rigueur est nul : `UserData` (donc `Played` et `IsFavorite`) arrive déjà dans
 * la réponse de la bibliothèque, qui est en cache. Deux listes sur cinq sortent d'un appel qu'on
 * faisait de toute façon — et elles sont, au passage, celles de la personne connectée et non
 * celles de l'administrateur.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const userId = session.jfId ?? session.u ?? null;
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  return withErrorHandling(async () => {
    const [movies, series, jfMovies, jfSeries, requests] = await Promise.all([
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
      session.jfId ? cachedJellyfinMovies(session.jfId).catch(() => []) : Promise.resolve([]),
      session.jfId ? cachedJellyfinSeries(session.jfId).catch(() => []) : Promise.resolve([]),
      config.jellyseerr.apiKey ? getPlayerRequests(session).catch(() => []) : Promise.resolve([]),
    ]);

    const movieLibrary = new Map(movies.map((m) => [m.tmdbId, m]));
    const seriesLibrary = new Map(series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s]));

    const local = watchlistDb.getAll(userId);
    const fromWatchlist = (status: string): PlayerListItem[] =>
      local
        .filter((w) => w.status === status)
        .map((w) => ({
          tmdbId: w.tmdbId,
          type: w.mediaType === "series" ? ("series" as const) : ("movie" as const),
          title: w.title,
          year: w.year,
          poster: w.posterPath,
          libraryId:
            (w.mediaType === "series" ? seriesLibrary.get(w.tmdbId)?.id : movieLibrary.get(w.tmdbId)?.id) ?? null,
          jellyfinId: null,
        }));

    const fromJellyfin = (items: JellyfinItem[], type: "movie" | "series", pick: (i: JellyfinItem) => boolean) =>
      items.filter(pick).map((item): PlayerListItem => {
        const tmdbRaw = getProviderIdCI(item.ProviderIds as Record<string, string> | undefined, "tmdb");
        const tmdbId = tmdbRaw ? Number.parseInt(tmdbRaw, 10) || null : null;
        const entry = tmdbId ? (type === "series" ? seriesLibrary.get(tmdbId) : movieLibrary.get(tmdbId)) : undefined;
        return {
          tmdbId,
          type,
          title: item.Name,
          year: item.ProductionYear ?? null,
          // L'image passe par notre propre route : celle de Jellyfin demande un jeton, et
          // l'optimiseur de Next ne transmet pas les cookies.
          poster: item.ImageTags?.Primary ? `/api/jellyfin/image?itemId=${item.Id}&tag=${item.ImageTags.Primary}` : null,
          libraryId: entry?.id ?? null,
          jellyfinId: item.Id,
        };
      });

    const byTitle = (a: PlayerListItem, b: PlayerListItem) => a.title.localeCompare(b.title);

    return {
      requests,
      toWatch: fromWatchlist("to_watch"),
      abandoned: fromWatchlist("abandoned"),
      watched: [
        ...fromJellyfin(jfMovies, "movie", (i) => Boolean(i.UserData?.Played)),
        ...fromJellyfin(jfSeries, "series", (i) => Boolean(i.UserData?.Played)),
      ].sort(byTitle),
      favorites: [
        ...fromJellyfin(jfMovies, "movie", (i) => Boolean(i.UserData?.IsFavorite)),
        ...fromJellyfin(jfSeries, "series", (i) => Boolean(i.UserData?.IsFavorite)),
      ].sort(byTitle),
    } satisfies PlayerListsPayload;
  }, "player-lists");
}

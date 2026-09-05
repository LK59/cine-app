import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { watchlistDb } from "@/lib/db";
import { cachedJellyfinMovies, cachedJellyfinSeries, getProviderIdCI } from "@/lib/server-cache";
import { playableLibrary } from "@/lib/playerLibrary";
import { getPlayerRequests, type PlayerRequest } from "@/lib/playerRequests";
import { posterUrl } from "@/lib/images";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { withErrorHandling } from "@/lib/api-helpers";
import { config } from "@/lib/config";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

export const dynamic = "force-dynamic";

/**
 * L'affiche d'une entrée de liste, quelle que soit la façon dont elle a été enregistrée.
 *
 * La colonne `poster_path` de la watchlist a deux formats selon l'écran qui a écrit la ligne :
 * un chemin TMDB nu (`/abc.jpg`), tel que TMDB le renvoie, pour tout ce qui vient du tableau de
 * bord ; une adresse complète pour ce qui vient du lecteur. Le chemin nu partait tel quel dans
 * `src` et le navigateur le lisait comme une adresse de notre propre serveur : d'où les cartes
 * « No image » sur tout ce qui n'était pas dans la bibliothèque.
 */
function watchlistPoster(stored: string | null): string | null {
  if (!stored) return null;
  if (/^https?:\/\//.test(stored) || stored.startsWith("/api/")) return stored;
  return `${TMDB_IMAGE_BASE}/w342${stored.startsWith("/") ? "" : "/"}${stored}`;
}

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
    const [lib, jfMovies, jfSeries, requests] = await Promise.all([
      playableLibrary(),
      session.jfId ? cachedJellyfinMovies(session.jfId).catch(() => []) : Promise.resolve([]),
      session.jfId ? cachedJellyfinSeries(session.jfId).catch(() => []) : Promise.resolve([]),
      config.jellyseerr.apiKey ? getPlayerRequests(session).catch(() => []) : Promise.resolve([]),
    ]);

    // Seulement ce que la bibliothèque peut vraiment ouvrir — voir playableLibrary.
    const movieLibrary = lib.movies;
    const seriesLibrary = lib.series;

    const local = watchlistDb.getAll(userId);
    const fromWatchlist = (statuses: string[]): PlayerListItem[] =>
      local
        .filter((w) => statuses.includes(w.status))
        .map((w) => {
          const entry = w.mediaType === "series" ? seriesLibrary.get(w.tmdbId) : movieLibrary.get(w.tmdbId);
          return {
            tmdbId: w.tmdbId,
            type: w.mediaType === "series" ? ("series" as const) : ("movie" as const),
            title: w.title,
            year: w.year,
            // L'affiche de la bibliothèque quand on l'a : c'est celle que le reste de l'interface
            // montre, et elle est à jour. Celle enregistrée dans la liste sert de repli — pour un
            // titre qu'on ne possède pas, c'est la seule.
            poster: (entry ? posterUrl(entry.images) : null) ?? watchlistPoster(w.posterPath),
            libraryId: entry?.id ?? null,
            jellyfinId: null,
          };
        });

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
      // « À demander » n'existe plus dans le lecteur, mais la colonne reste et le tableau de bord
      // s'en sert encore. Ces lignes sont des intentions comme les autres : les cacher aurait fait
      // disparaître une quarantaine de titres que Louis avait rangés là. Elles rejoignent « À
      // voir », qui dit exactement la même chose de ce côté-ci.
      toWatch: fromWatchlist(["to_watch", "to_request"]),
      abandoned: fromWatchlist(["abandoned"]),
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

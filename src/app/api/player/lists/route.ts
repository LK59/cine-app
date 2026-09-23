import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { watchlistDb } from "@/lib/db";
import { migrateFavoritesToWatchlist } from "@/lib/migrateFavorites";
import { cachedJellyfinPlayed, cachedJellyfinFavorites, getProviderIdCI } from "@/lib/server-cache";
import { playableLibrary } from "@/lib/playerLibrary";
import { getPlayerRequests, type PlayerRequest } from "@/lib/playerRequests";
import { posterUrl, libraryPoster } from "@/lib/images";
import { getTitleArt } from "@/lib/title-art";
import { getTitleNames } from "@/lib/titleNames";
import { localeOf } from "@/lib/i18n";
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
  /**
   * Quand ce titre est entré dans la liste, pour ce qu'on y a rangé soi-même.
   *
   * Nul pour ce qui vient de Jellyfin : « vu » et « favori » y vivent, et Jellyfin ne dit pas
   * quand un titre a été marqué. Un tri par date d'ajout retombe alors sur le titre plutôt que
   * d'inventer un ordre.
   */
  addedAt: number | null;
}

/**
 * Trois listes, et c'est tout.
 *
 * « Abandonné » n'avait plus rien pour l'alimenter — aucun écran ne permettait d'y ranger quoi que
 * ce soit — et « Favoris » disait la même chose qu'« À voir » avec un autre mot, en tirant sa
 * vérité d'ailleurs. Les favoris existants ont rejoint « À voir » (voir `migrateFavorites`) ; le
 * cœur reste chez Jellyfin, où il veut dire quelque chose.
 */
export interface PlayerListsPayload {
  requests: PlayerRequest[];
  toWatch: PlayerListItem[];
  watched: PlayerListItem[];
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
    // Une requête ciblée plutôt qu'un balayage de la bibliothèque filtré ensuite : elle répond
    // juste là où l'énumération par compte est incomplète sur cette installation, et elle
    // rapporte quelques dizaines d'éléments au lieu de plusieurs centaines.
    const [lib, played, requests] = await Promise.all([
      playableLibrary(),
      session.jfId ? cachedJellyfinPlayed(session.jfId).catch(() => []) : Promise.resolve([]),
      config.jellyseerr.apiKey ? getPlayerRequests(session).catch(() => []) : Promise.resolve([]),
    ]);

    // Les favoris Jellyfin qui n'avaient pas encore de ligne dans la liste locale y entrent ici,
    // une fois par compte. Voir `migrateFavoritesToWatchlist` : la migration se fait à la lecture
    // parce que les favoris sont par compte, et qu'un compte n'existe pour nous qu'une fois qu'il
    // s'est connecté.
    if (session.jfId && userId) await migrateFavoritesToWatchlist(userId, session.jfId).catch(() => {});

    // Seulement ce que la bibliothèque peut vraiment ouvrir — voir playableLibrary.
    const movieLibrary = lib.movies;
    const seriesLibrary = lib.series;

    const local = watchlistDb.getAll(userId);
    /**
     * Les affiches localisées des titres qu'on possède, lues au même endroit que le catalogue.
     *
     * Sans ça, « Ma liste » montrait l'affiche de Radarr là où la rangée d'à côté montrait celle
     * du site — le défaut signalé le 19/09/2026. `getTitleArt` est en cache disque une semaine et
     * ne concerne ici que les titres de la liste, qui se comptent en dizaines.
     */
    const locale = localeOf(req);
    // Dans sa propre garde : une affiche est un ornement, et rien de ce qui la cherche ne doit
    // pouvoir emporter la liste elle-même. C'est la règle de CLAUDE.md sur les vérifications qui
    // tournent sur le chemin d'erreur d'autrui — ici, on retombe simplement sur l'affiche de
    // Radarr, c'est-à-dire sur ce qui s'affichait hier.
    const artByTmdb = await Promise.all(
      local.map(async (w) => {
        const entry = w.mediaType === "series" ? seriesLibrary.get(w.tmdbId) : movieLibrary.get(w.tmdbId);
        if (!entry) return [w.tmdbId, undefined] as const;
        const art = await getTitleArt(w.tmdbId, w.mediaType === "series" ? "series" : "movie");
        return [w.tmdbId, art.posterByLang] as const;
      })
    )
      .then((rows) => new Map(rows))
      .catch(() => new Map<number, Partial<Record<string, string>> | undefined>());
    const fromWatchlist = (statuses: string[]): PlayerListItem[] =>
      local
        .filter((w) => statuses.includes(w.status))
        .map((w) => {
          const entry = w.mediaType === "series" ? seriesLibrary.get(w.tmdbId) : movieLibrary.get(w.tmdbId);
          return {
            tmdbId: w.tmdbId,
            type: w.mediaType === "series" ? ("series" as const) : ("movie" as const),
            // Le titre enregistré est celui de l'écran d'où on l'a rangé — souvent celui de
            // Radarr, donc en anglais. La langue de qui regarde d'abord (voir `titleNames`).
            title: getTitleNames(w.tmdbId, w.mediaType === "series" ? "series" : "movie")[locale] || w.title,
            year: w.year,
            // L'affiche de la bibliothèque quand on l'a : c'est celle que le reste de l'interface
            // montre, et elle est à jour. Celle enregistrée dans la liste sert de repli — pour un
            // titre qu'on ne possède pas, c'est la seule.
            poster:
              (entry ? libraryPoster(artByTmdb.get(w.tmdbId), entry.images, locale) : null) ??
              watchlistPoster(w.posterPath),
            libraryId: entry?.id ?? null,
            jellyfinId: null,
            addedAt: w.updatedAt,
          };
        });

    // Le type vient de l'élément lui-même : ces deux listes mélangent films et séries.
    const fromJellyfin = (items: JellyfinItem[]) =>
      items.map((item): PlayerListItem => {
        const type: "movie" | "series" = item.Type === "Series" ? "series" : "movie";
        const tmdbRaw = getProviderIdCI(item.ProviderIds as Record<string, string> | undefined, "tmdb");
        const tmdbId = tmdbRaw ? Number.parseInt(tmdbRaw, 10) || null : null;
        const entry = tmdbId ? (type === "series" ? seriesLibrary.get(tmdbId) : movieLibrary.get(tmdbId)) : undefined;
        return {
          tmdbId,
          type,
          title: (tmdbId ? getTitleNames(tmdbId, type)[locale] : undefined) || item.Name,
          year: item.ProductionYear ?? null,
          // L'image passe par notre propre route : celle de Jellyfin demande un jeton, et
          // l'optimiseur de Next ne transmet pas les cookies.
          poster: item.ImageTags?.Primary ? `/api/jellyfin/image?itemId=${item.Id}&tag=${item.ImageTags.Primary}` : null,
          libraryId: entry?.id ?? null,
          jellyfinId: item.Id,
          addedAt: null,
        };
      });

    const byTitle = (a: PlayerListItem, b: PlayerListItem) => a.title.localeCompare(b.title);

    return {
      requests,
      // Une seule liste depuis le 21/09/2026 : les anciens « à demander » et « favoris » ont été
      // ramenés à « À voir » par `migrate()`, où ils apparaissaient déjà ici — mais pas dans la
      // rangée « Ma liste » du cinéma, qui ne lisait que to_watch.
      toWatch: fromWatchlist(["to_watch"]),
      watched: fromJellyfin(played).sort(byTitle),
    } satisfies PlayerListsPayload;
  }, "player-lists");
}

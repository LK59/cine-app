import { NextRequest, NextResponse } from "next/server";
import { errorBody, renameNotFound } from "@/lib/apiErrorCodes";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { playableLibrary, playableId } from "@/lib/playerLibrary";
import { getTmdbLocale, LOCALE_COOKIE, localeOf } from "@/lib/i18n";
import { getTitleArt, logoForLocale } from "@/lib/title-art";
import { getTitleNames } from "@/lib/titleNames";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { watchlistDb, type WatchlistStatus } from "@/lib/db";
import { withErrorHandling } from "@/lib/api-helpers";
import { resolveRequestState, isReleased, type PlayerRequestState } from "@/lib/playerRequestState";
import { config } from "@/lib/config";
import { titleDownloadProgress } from "@/lib/downloadProgress";
import { tvEpisodeRuntime } from "@/lib/tvRuntime";
import { isWatchedLocally } from "@/lib/watched";
import { hiddenTmdbKeysFor } from "@/lib/blockedTags";

export const dynamic = "force-dynamic";

export interface PlayerTitleCast {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface PlayerTitlePayload {
  tmdbId: number;
  type: "movie" | "series";
  title: string;
  year: number | null;
  releaseDate: string | null;
  overview: string;
  tagline: string | null;
  poster: string | null;
  backdrop: string | null;
  genres: string[];
  runtime: number | null;
  rating: number;
  cast: PlayerTitleCast[];
  /** L'identifiant de la fiche cinéma quand le titre est déjà là — sinon `null`. */
  libraryId: number | null;
  requestState: PlayerRequestState | null;
  watchlistStatus: WatchlistStatus | null;
  /**
   * La part déjà téléchargée (0 à 1) d'un titre demandé qui arrive, `null` sinon. Seulement pour
   * un titre absent de la bibliothèque — voir `titleDownloadProgress`.
   */
  downloading: number | null;
  /**
   * Vu par ce compte (DECISIONS.md §51) : la copie locale, qui tient aussi les titres absents de
   * Jellyfin. Le bouton « Vu » de la fiche de découverte la lit et l'écrit.
   */
  watched: boolean;
  /** Le chemin TMDB de l'affiche, gardé avec un titre marqué vu (sa seule image s'il n'est pas chez nous). */
  posterPath: string | null;
  /**
   * Le logo du titre dans la langue de qui regarde (`logoForLocale`, DECISIONS.md §58), `null` sans
   * logo. Ajouté le 14/10/2026 : la fiche découverte du bureau se dessine désormais comme celle
   * d'un film de la bibliothèque, logo en tête de colonne, et n'avait que le titre écrit.
   */
  logo: string | null;
}

/**
 * La fiche d'un titre vue depuis le lecteur, qu'on le possède ou non.
 *
 * C'est la route qui permet à un titre absent d'ouvrir une *vraie* fiche — affiche, synopsis,
 * distribution — au lieu d'une fenêtre à deux boutons. Elle répond aussi pour un titre présent,
 * parce qu'une filmographie mélange les deux et qu'il ne doit y avoir qu'un seul chemin.
 *
 * Aucune information d'outillage ne sort d'ici : ni identifiant Radarr nommé comme tel, ni
 * statut Jellyseerr brut. `libraryId` dit « on l'a, voilà où », `requestState` dit où en est
 * l'attente, et c'est tout ce que l'interface a besoin de savoir.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ type: string; tmdbId: string }> }) {
  const params = await props.params;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const type = params.type === "series" ? "series" : params.type === "movie" ? "movie" : null;
  const tmdbId = Number.parseInt(params.tmdbId, 10);
  if (!type || !Number.isFinite(tmdbId) || tmdbId <= 0) {
    return NextResponse.json(errorBody("Paramètres invalides", "invalid_request"), { status: 400 });
  }

  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get(LOCALE_COOKIE)?.value));
  if (!tmdb.isEnabled()) return NextResponse.json(errorBody("TMDB non configuré", "service_unavailable"), { status: 503 });

  return withErrorHandling(async () => {
    const userId = session.jfId ?? session.u ?? null;

    // L'état du titre chez Jellyseerr est le même pour tout le monde (`mediaInfo.status`) : il est
    // lu avec la clé d'API. Il l'était avec le cookie de session, qui peut avoir expiré alors que la
    // session cine-app, elle, glisse — Jellyseerr répondait alors 403, avalé en silence, et un titre
    // déjà demandé s'affichait « à demander » (23/09/2026). Sans Jellyseerr configuré, la fiche
    // s'affiche quand même : elle perd la demande, pas le reste.
    /**
     * Un titre que les tags bloqués du compte lui cachent n'existe pas pour lui (DECISIONS.md §54) :
     * ni « dans la bibliothèque », ni en cours de téléchargement, ni « disponible » chez Jellyseerr.
     * La fiche TMDB l'annonçait possédé — le seul écran qui le disait encore (08/10/2026).
     */
    const hidden = (await hiddenTmdbKeysFor(session.jfId).catch(() => new Set<string>())).has(`${type}:${tmdbId}`);
    const media =
      config.jellyseerr.apiKey && !hidden
        ? await (type === "movie" ? jellyseerr.getMovieMedia(tmdbId) : jellyseerr.getTvMedia(tmdbId)).catch(() => null)
        : null;

    if (type === "movie") {
      const [detail, lib, logo] = await Promise.all([
        // Un titre que TMDB ne connaît plus (lien ancien) : « Titre introuvable », pas le corps de
        // TMDB — voir `renameNotFound` (ROBUSTESSE-7).
        renameNotFound(tmdb.getMovie(tmdbId), "Titre introuvable", "title_not_found"),
        playableLibrary(),
        titleLogo("movie", tmdbId, req),
      ]);
      // Ouvrable, pas seulement connu de Radarr : un film surveillé sans fichier n'a pas de fiche
      // à ouvrir, et lui donner un identifiant menait à un clic qui ne faisait rien.
      const libraryId = hidden ? null : playableId(lib, "movie", tmdbId);
      const downloading = libraryId === null && !hidden ? await titleDownloadProgress("movie", tmdbId) : null;
      return build({
        tmdbId,
        type,
        title: detail.title ?? "",
        releaseDate: detail.release_date || null,
        overview: detail.overview ?? "",
        tagline: detail.tagline ?? null,
        posterPath: detail.poster_path,
        backdropPath: detail.backdrop_path,
        genres: (detail.genres ?? []).map((g) => g.name),
        runtime: detail.runtime ?? null,
        rating: detail.vote_average ?? 0,
        cast: detail.credits?.cast ?? [],
        libraryId,
        mediaStatus: media?.mediaInfo?.status ?? null,
        watchlistStatus: userId ? watchlistDb.get(userId, "movie", tmdbId)?.status ?? null : null,
        downloading,
        watched: userId ? isWatchedLocally(userId, "movie", tmdbId) : false,
        logo,
      });
    }

    const [detail, lib, logo] = await Promise.all([
      renameNotFound(tmdb.getTv(tmdbId), "Titre introuvable", "title_not_found"),
      playableLibrary(),
      titleLogo("series", tmdbId, req),
    ]);
    const libraryId = hidden ? null : playableId(lib, "series", tmdbId);
    const downloading = libraryId === null && !hidden ? await titleDownloadProgress("series", tmdbId) : null;
    return build({
      tmdbId,
      type,
      title: detail.name ?? "",
      releaseDate: detail.first_air_date || null,
      overview: detail.overview ?? "",
      tagline: detail.tagline ?? null,
      posterPath: detail.poster_path,
      backdropPath: detail.backdrop_path,
      genres: (detail.genres ?? []).map((g) => g.name),
      // La durée d'un épisode : c'est celle qu'on veut savoir d'une série. Elle était laissée vide.
      runtime: tvEpisodeRuntime(detail),
      rating: detail.vote_average ?? 0,
      cast: detail.credits?.cast ?? [],
      libraryId,
      mediaStatus: media?.mediaInfo?.status ?? null,
      watchlistStatus: userId ? watchlistDb.get(userId, "series", tmdbId)?.status ?? null : null,
      downloading,
      watched: userId ? isWatchedLocally(userId, "series", tmdbId) : false,
      logo,
    });
  }, "player-title");
}

/**
 * Le logo, de la même entrée de cache que le catalogue (`getTitleArt`, une semaine sur disque).
 * Un ornement : un échec rend le titre écrit, jamais une fiche en erreur.
 */
async function titleLogo(type: "movie" | "series", tmdbId: number, req: NextRequest): Promise<string | null> {
  try {
    const art = await getTitleArt(tmdbId, type);
    return logoForLocale(art, getTitleNames(tmdbId, type), localeOf(req));
  } catch {
    return null;
  }
}

function build(input: {
  tmdbId: number;
  type: "movie" | "series";
  title: string;
  releaseDate: string | null;
  overview: string;
  tagline: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  genres: string[];
  runtime: number | null;
  rating: number;
  cast: { id: number; name: string; character: string; profile_path: string | null }[];
  libraryId: number | null;
  mediaStatus: number | null;
  watchlistStatus: WatchlistStatus | null;
  downloading: number | null;
  watched: boolean;
  logo: string | null;
}): PlayerTitlePayload {
  return {
    tmdbId: input.tmdbId,
    type: input.type,
    title: input.title,
    year: input.releaseDate ? Number.parseInt(input.releaseDate.slice(0, 4), 10) || null : null,
    releaseDate: input.releaseDate,
    overview: input.overview,
    tagline: input.tagline || null,
    poster: input.posterPath ? `${TMDB_IMAGE_BASE}/w500${input.posterPath}` : null,
    backdrop: input.backdropPath ? `${TMDB_IMAGE_BASE}/w1280${input.backdropPath}` : null,
    genres: input.genres,
    runtime: input.runtime,
    rating: input.rating,
    cast: input.cast.slice(0, 16).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character,
      profilePath: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : null,
    })),
    libraryId: input.libraryId,
    // Pas de demande connue et pas encore dans la bibliothèque : il n'y a rien à dire, l'action
    // reste « Demander ». Une demande existante, elle, a toujours un état.
    requestState:
      input.mediaStatus == null
        ? null
        : resolveRequestState({ mediaStatus: input.mediaStatus, released: isReleased(input.releaseDate) }),
    watchlistStatus: input.watchlistStatus,
    downloading: input.downloading,
    watched: input.watched,
    posterPath: input.posterPath,
    logo: input.logo,
  };
}

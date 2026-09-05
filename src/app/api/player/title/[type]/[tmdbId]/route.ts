import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { playableLibrary, playableId } from "@/lib/playerLibrary";
import { getTmdbLocale, LOCALE_COOKIE } from "@/lib/i18n";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { watchlistDb, type WatchlistStatus } from "@/lib/db";
import { withErrorHandling } from "@/lib/api-helpers";
import { resolveRequestState, isReleased, type PlayerRequestState } from "@/lib/playerRequestState";
import { config } from "@/lib/config";

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
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get(LOCALE_COOKIE)?.value));
  if (!tmdb.isEnabled()) return NextResponse.json({ error: "TMDB non configuré" }, { status: 503 });

  return withErrorHandling(async () => {
    const userId = session.jfId ?? session.u ?? null;

    // Jellyseerr est interrogé avec le cookie de la personne quand il existe, pour que l'état
    // rendu soit bien le sien. Sans Jellyseerr configuré, la fiche s'affiche quand même : elle
    // perd la demande, pas le reste.
    const media = config.jellyseerr.apiKey
      ? await (type === "movie"
          ? jellyseerr.getMovieMedia(tmdbId, session.jsCookie)
          : jellyseerr.getTvMedia(tmdbId, session.jsCookie)
        ).catch(() => null)
      : null;

    if (type === "movie") {
      const [detail, lib] = await Promise.all([tmdb.getMovie(tmdbId), playableLibrary()]);
      // Ouvrable, pas seulement connu de Radarr : un film surveillé sans fichier n'a pas de fiche
      // à ouvrir, et lui donner un identifiant menait à un clic qui ne faisait rien.
      const libraryId = playableId(lib, "movie", tmdbId);
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
      });
    }

    const [detail, lib] = await Promise.all([tmdb.getTv(tmdbId), playableLibrary()]);
    const libraryId = playableId(lib, "series", tmdbId);
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
      runtime: null,
      rating: detail.vote_average ?? 0,
      cast: detail.credits?.cast ?? [],
      libraryId,
      mediaStatus: media?.mediaInfo?.status ?? null,
      watchlistStatus: userId ? watchlistDb.get(userId, "series", tmdbId)?.status ?? null : null,
    });
  }, "player-title");
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
  };
}

import { TMDB_IMAGE_BASE, type TmdbMovie, type TmdbTv } from "@/lib/clients/tmdb";
import { tvEpisodeRuntime } from "@/lib/tvRuntime";

/**
 * La part TMDB d'une description de fiche (`/api/radarr/movies/<id>/info`,
 * `/api/sonarr/series/<id>/info`) — écrite une fois, parce qu'un titre que Jellyfin a seul
 * (DECISIONS.md §89) passe par les mêmes adresses avec une autre source d'identité, et que deux
 * copies de cette forme finiraient par ne plus dire la même chose aux fiches.
 */

const castOf = (credits: TmdbMovie["credits"] | TmdbTv["credits"]) =>
  (credits?.cast ?? []).slice(0, 12).map((c) => ({
    tmdbId: c.id,
    name: c.name,
    character: c.character,
    photoUrl: c.profile_path ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}` : null,
  }));

export function movieTmdbFacts(details: TmdbMovie) {
  return {
    overview: details.overview,
    tagline: details.tagline,
    genres: details.genres?.map((g) => g.name) ?? [],
    runtime: details.runtime,
    backdropUrl: details.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${details.backdrop_path}` : null,
    cast: castOf(details.credits),
    collection: details.belongs_to_collection ? { id: details.belongs_to_collection.id, name: details.belongs_to_collection.name } : null,
  };
}

export function seriesTmdbFacts(details: TmdbTv, sonarrRuntime: number | null | undefined) {
  return {
    overview: details.overview,
    tagline: details.tagline,
    genres: details.genres?.map((g) => g.name) ?? [],
    runtime: tvEpisodeRuntime(details, sonarrRuntime),
    backdropUrl: details.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${details.backdrop_path}` : null,
    cast: castOf(details.credits),
  };
}

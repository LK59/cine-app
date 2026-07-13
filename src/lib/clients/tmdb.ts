import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { apiKey } = config.tmdb;
const BASE = "https://api.themoviedb.org/3";

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export interface TmdbPerson {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department: string;
  known_for: { id: number; title?: string; name?: string; media_type: string }[];
}

export interface TmdbMultiResult {
  id: number;
  media_type: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  poster_path?: string | null;
  profile_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  overview?: string;
  genre_ids?: number[];
  known_for_department?: string;
  known_for?: { id: number; title?: string; name?: string }[];
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string;
  profile_path: string | null;
}

export interface TmdbPersonCredit {
  id: number;
  title?: string;
  name?: string;
  media_type: "movie" | "tv";
  poster_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  character: string;
  popularity: number;
}

export interface TmdbMovie {
  overview: string;
  genres: { id: number; name: string }[];
  backdrop_path: string | null;
  poster_path: string | null;
  runtime: number | null;
  tagline?: string;
  imdb_id?: string | null;
  credits?: { cast: TmdbCastMember[]; crew?: TmdbCrewMember[] };
  belongs_to_collection?: { id: number; name: string; poster_path: string | null } | null;
}

export interface TmdbCollection {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  parts: {
    id: number;
    title: string;
    poster_path: string | null;
    release_date: string;
    vote_average: number;
  }[];
}

export interface TmdbTv {
  overview: string;
  genres: { id: number; name: string }[];
  backdrop_path: string | null;
  poster_path: string | null;
  episode_run_time?: number[];
  tagline?: string;
  created_by?: { id: number; name: string; profile_path: string | null }[];
  credits?: { cast: TmdbCastMember[]; crew?: TmdbCrewMember[] };
  external_ids?: { imdb_id?: string | null };
}

export interface TmdbTrendingMovie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  genre_ids: number[];
}

export interface TmdbTrendingTv {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string;
  vote_average: number;
  genre_ids: number[];
}

function enabled(): boolean {
  return Boolean(apiKey);
}

function createTmdbClient(lang = "fr-FR") {
  const videoLangs = lang.startsWith("en") ? "en,null" : lang.startsWith("es") ? "es,en,null" : "fr,en,null";
  return {
    isEnabled: enabled,
    checkAuth: () =>
      fetchJson<{ success: boolean }>(`${BASE}/authentication?api_key=${apiKey}`),
    getMovie: (tmdbId: number) =>
      fetchJson<TmdbMovie>(
        `${BASE}/movie/${tmdbId}?api_key=${apiKey}&language=${lang}&append_to_response=credits`
      ),
    findTvByTvdbId: (tvdbId: number) =>
      fetchJson<{ tv_results: { id: number }[] }>(
        `${BASE}/find/${tvdbId}?api_key=${apiKey}&external_source=tvdb_id&language=${lang}`
      ),
    getTv: (tmdbTvId: number) =>
      fetchJson<TmdbTv>(
        `${BASE}/tv/${tmdbTvId}?api_key=${apiKey}&language=${lang}&append_to_response=credits,external_ids`
      ),
    trendingMovies: () =>
      fetchJson<{ results: TmdbTrendingMovie[] }>(
        `${BASE}/trending/movie/week?api_key=${apiKey}&language=${lang}`
      ),
    trendingTv: () =>
      fetchJson<{ results: TmdbTrendingTv[] }>(
        `${BASE}/trending/tv/week?api_key=${apiKey}&language=${lang}`
      ),
    movieGenres: () =>
      fetchJson<{ genres: { id: number; name: string }[] }>(
        `${BASE}/genre/movie/list?api_key=${apiKey}&language=${lang}`
      ),
    tvGenres: () =>
      fetchJson<{ genres: { id: number; name: string }[] }>(
        `${BASE}/genre/tv/list?api_key=${apiKey}&language=${lang}`
      ),
    movieRecommendations: (tmdbId: number) =>
      fetchJson<{ results: TmdbTrendingMovie[] }>(
        `${BASE}/movie/${tmdbId}/recommendations?api_key=${apiKey}&language=${lang}`
      ),
    tvRecommendations: (tmdbId: number) =>
      fetchJson<{ results: TmdbTrendingTv[] }>(
        `${BASE}/tv/${tmdbId}/recommendations?api_key=${apiKey}&language=${lang}`
      ),
    searchMovies: (query: string) =>
      fetchJson<{ results: TmdbTrendingMovie[] }>(
        `${BASE}/search/movie?api_key=${apiKey}&language=${lang}&query=${encodeURIComponent(query)}&include_adult=false`
      ),
    searchTv: (query: string) =>
      fetchJson<{ results: TmdbTrendingTv[] }>(
        `${BASE}/search/tv?api_key=${apiKey}&language=${lang}&query=${encodeURIComponent(query)}&include_adult=false`
      ),
    getMovieVideos: (tmdbId: number) =>
      fetchJson<{ results: { key: string; site: string; type: string; official: boolean }[] }>(
        `${BASE}/movie/${tmdbId}/videos?api_key=${apiKey}&language=${lang}&include_video_language=${videoLangs}`
      ),
    getTvVideos: (tmdbTvId: number) =>
      fetchJson<{ results: { key: string; site: string; type: string; official: boolean }[] }>(
        `${BASE}/tv/${tmdbTvId}/videos?api_key=${apiKey}&language=${lang}&include_video_language=${videoLangs}`
      ),
    getPersonDetails: (personId: number) =>
      fetchJson<{
        id: number;
        name: string;
        biography: string;
        birthday: string | null;
        deathday: string | null;
        place_of_birth: string | null;
        known_for_department: string | null;
        popularity: number;
        profile_path: string | null;
      }>(`${BASE}/person/${personId}?api_key=${apiKey}&language=${lang}`),
    getPersonCredits: (personId: number) =>
      fetchJson<{ cast: TmdbPersonCredit[] }>(
        `${BASE}/person/${personId}/combined_credits?api_key=${apiKey}&language=${lang}`
      ),
    getPersonImages: (personId: number) =>
      fetchJson<{ profiles: { file_path: string; vote_average: number; width: number; height: number }[] }>(
        `${BASE}/person/${personId}/images?api_key=${apiKey}`
      ),
    getPersonExternalIds: (personId: number) =>
      fetchJson<{ imdb_id: string | null; instagram_id: string | null; twitter_id: string | null; wikidata_id: string | null }>(
        `${BASE}/person/${personId}/external_ids?api_key=${apiKey}`
      ),
    getCollection: (collectionId: number) =>
      fetchJson<TmdbCollection>(
        `${BASE}/collection/${collectionId}?api_key=${apiKey}&language=${lang}`
      ),
    searchPerson: (query: string) =>
      fetchJson<{ results: TmdbPerson[] }>(
        `${BASE}/search/person?api_key=${apiKey}&language=${lang}&query=${encodeURIComponent(query)}&include_adult=false`
      ),
    searchMulti: (query: string) =>
      fetchJson<{ results: TmdbMultiResult[] }>(
        `${BASE}/search/multi?api_key=${apiKey}&language=${lang}&query=${encodeURIComponent(query)}&include_adult=false`
      ),
    discover: (params: {
      mediaType: "movie" | "tv";
      genreId?: number;
      castIds?: number[];
      crewIds?: number[];
      query?: string;
    }) => {
      const qs = new URLSearchParams({
        api_key: apiKey,
        language: lang,
        sort_by: "popularity.desc",
        include_adult: "false",
      });
      if (params.genreId) qs.set("with_genres", String(params.genreId));
      if (params.mediaType === "movie") {
        if (params.castIds?.length) qs.set("with_cast", params.castIds.join(","));
        if (params.crewIds?.length) qs.set("with_crew", params.crewIds.join(","));
      } else {
        const peopleIds = [...(params.castIds ?? []), ...(params.crewIds ?? [])];
        if (peopleIds.length) qs.set("with_people", peopleIds.join(","));
      }
      if (params.query) qs.set("query", params.query);
      return fetchJson<{ results: (TmdbTrendingMovie | TmdbTrendingTv)[] }>(
        `${BASE}/discover/${params.mediaType}?${qs.toString()}`
      );
    },
    discoverByPerson: (personId: number, mediaType: "movie" | "tv") => {
      const key = mediaType === "movie" ? "with_cast" : "with_people";
      const endpoint = mediaType === "movie" ? "movie" : "tv";
      return fetchJson<{ results: (TmdbTrendingMovie | TmdbTrendingTv)[] }>(
        `${BASE}/discover/${endpoint}?api_key=${apiKey}&language=${lang}&${key}=${personId}&sort_by=popularity.desc`
      );
    },
  };
}

export { createTmdbClient };
export const tmdb = createTmdbClient("fr-FR");

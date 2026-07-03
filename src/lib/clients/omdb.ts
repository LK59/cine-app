import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { apiKey } = config.omdb;

export interface OmdbRating {
  imdbRating: string;
  imdbVotes: string;
  Response: "True" | "False";
}

export const omdb = {
  isEnabled: () => Boolean(apiKey),
  getRating: (imdbId: string) =>
    fetchJson<OmdbRating>(`https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`),
  // The Shawshank Redemption — a fixed, always-valid IMDb id used purely to
  // verify the API key works.
  checkKey: () => fetchJson<OmdbRating>(`https://www.omdbapi.com/?i=tt0111161&apikey=${apiKey}`),
};

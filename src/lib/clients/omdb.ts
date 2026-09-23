import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { apiKey } = config.omdb;

export interface OmdbRating {
  imdbRating: string;
  imdbVotes: string;
  Response: "True" | "False";
}

/**
 * Une heure de silence après un refus d'OMDb.
 *
 * Un échec n'était pas retenu : quota épuisé, chaque ouverture du catalogue des séries relançait
 * ses cent trente demandes de note, toutes refusées — le quota du lendemain commençait déjà
 * entamé par ceux qui ouvraient l'app le soir. Pendant la pause, on ne demande rien : les notes
 * déjà en cache restent affichées, les autres attendent.
 */
const PAUSE_MS = 3600_000;
let pausedUntil = 0;

/** Pour les tests. */
export function resetOmdbPause(): void {
  pausedUntil = 0;
}

export const omdb = {
  isEnabled: () => Boolean(apiKey),
  getRating: async (imdbId: string) => {
    if (Date.now() < pausedUntil) throw new Error("OMDb en pause après un refus");
    try {
      return await fetchJson<OmdbRating>(`https://www.omdbapi.com/?i=${imdbId}&apikey=${apiKey}`);
    } catch (err) {
      pausedUntil = Date.now() + PAUSE_MS;
      throw err;
    }
  },
  // The Shawshank Redemption — a fixed, always-valid IMDb id used purely to
  // verify the API key works.
  checkKey: () => fetchJson<OmdbRating>(`https://www.omdbapi.com/?i=tt0111161&apikey=${apiKey}`),
};

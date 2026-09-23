import { createTmdbClient } from "@/lib/clients/tmdb";
import { withPersistentCache } from "@/lib/server-cache";

/**
 * Ce que la bannière du bureau affiche d'un titre, et rien d'autre : le synopsis traduit et les
 * premiers noms de la distribution.
 *
 * Elle le lisait dans `/api/radarr/movies/{id}/info` (et son pendant séries) — la requête de la
 * fiche complète, la plus lourde de l'application : Radarr d'abord, puis TMDB, OMDb, Bazarr, la
 * file de téléchargement et le logo, et le plus lent des six faisait attendre. Le logo et le visuel,
 * venus du catalogue, étaient là depuis une seconde quand le synopsis arrivait (relevé le
 * 23/09/2026). Ici, TMDB seul, gardé une semaine par titre et par langue — en SQLite, pour qu'un
 * redéploiement ne le vide pas.
 */
export type HeroMediaType = "movie" | "series";

export interface HeroInfo {
  tmdb: { overview: string; cast: { name: string }[] } | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CAST_SHOWN = 5;

export async function heroInfo(type: HeroMediaType, tmdbId: number, locale: string): Promise<HeroInfo> {
  const tmdb = createTmdbClient(locale);
  if (!tmdb.isEnabled()) return { tmdb: null };
  // Un échec n'est pas gardé : `withPersistentCache` ne garde que ce que la fonction rend, et
  // l'erreur la traverse. On rend alors « rien » sans le retenir — la bannière retombe sur le
  // synopsis du catalogue, et la prochaine demande réessaie.
  try {
    return await withPersistentCache(`hero:${type}:${tmdbId}:${locale}`, WEEK_MS, async () => {
      const details = type === "movie" ? await tmdb.getMovie(tmdbId) : await tmdb.getTv(tmdbId);
      return {
        tmdb: {
          overview: details.overview ?? "",
          cast: (details.credits?.cast ?? []).slice(0, CAST_SHOWN).map((c) => ({ name: c.name })),
        },
      };
    });
  } catch {
    return { tmdb: null };
  }
}

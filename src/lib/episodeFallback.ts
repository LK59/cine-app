import { createTmdbClient } from "@/lib/clients/tmdb";
import { withPersistentCache } from "@/lib/server-cache";
import { getTmdbLocale, type Locale } from "@/lib/i18n";

/**
 * Le résumé et le titre d'un épisode quand Jellyfin n'en a pas — mieux vaut l'anglais que rien.
 *
 * Jellyfin range ses métadonnées dans la langue du serveur. Quand TMDB n'a pas traduit une saison,
 * les épisodes arrivent sans résumé et sous un titre de remplissage (« Épisode 2 ») — relevé le
 * 23/09/2026 sur la saison 3 de *The Creep Tapes*, dont les titres et résumés existaient bien en
 * anglais.
 *
 * L'ordre, décidé par Louis : ce que Jellyfin a, puis TMDB dans la langue de qui regarde, puis
 * TMDB en anglais. Chaque réponse de TMDB est gardée une semaine (étalée, voir `spreadTtl`) : au
 * bout d'une semaine, la langue de qui regarde est redemandée — une traduction arrivée entre-temps
 * remplace alors l'anglais. Et ce que Jellyfin sait passe toujours en premier : dès qu'il a
 * lui-même la traduction, plus rien n'est comblé.
 */
const WEEK_MS = 7 * 24 * 3600_000;

/** Un titre qui ne dit rien : « Épisode 3 », « Episode 3 », « Episodio 3 », « Folge 3 »… */
const PLACEHOLDER_TITLE = /^(épisode|episode|episodio|capítulo|folge|ep\.?)\s*\d+$/i;

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  return !title || PLACEHOLDER_TITLE.test(title.trim());
}

type SeasonText = Map<number, { name?: string; overview?: string }>;

async function seasonText(tmdbTvId: number, seasonNumber: number, lang: string): Promise<SeasonText> {
  const episodes = await withPersistentCache(`tmdb:season-text:${lang}:${tmdbTvId}:${seasonNumber}`, WEEK_MS, async () => {
    const data = await createTmdbClient(lang).getTvSeason(tmdbTvId, seasonNumber);
    return (data.episodes ?? []).map((e) => ({
      n: e.episode_number,
      // Un titre de remplissage n'est pas une traduction : on ne le retient pas.
      name: e.name && !isPlaceholderTitle(e.name) ? e.name : undefined,
      overview: e.overview?.trim() || undefined,
    }));
  });
  return new Map(episodes.map((e) => [e.n, { name: e.name, overview: e.overview }]));
}

export interface EpisodeText {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview: string | null;
}

/**
 * Complète, en place, les épisodes qui n'ont pas de résumé ou qui n'ont qu'un titre de
 * remplissage. Ne demande rien à TMDB tant qu'aucun épisode n'en a besoin, et une saison à la fois.
 * Une panne de TMDB laisse les épisodes tels qu'ils étaient.
 */
export async function fillEpisodeText<T extends EpisodeText>(
  episodes: T[],
  tmdbTvId: number | null | undefined,
  locale: Locale
): Promise<void> {
  if (!tmdbTvId) return;
  const needy = episodes.filter((e) => !e.overview || isPlaceholderTitle(e.title));
  if (needy.length === 0) return;
  const langs = [...new Set([getTmdbLocale(locale), "en-US"])];
  for (const seasonNumber of new Set(needy.map((e) => e.seasonNumber))) {
    const sources = await Promise.all(langs.map((lang) => seasonText(tmdbTvId, seasonNumber, lang).catch(() => null)));
    for (const ep of needy.filter((e) => e.seasonNumber === seasonNumber)) {
      for (const source of sources) {
        const found = source?.get(ep.episodeNumber);
        if (!found) continue;
        if (!ep.overview && found.overview) ep.overview = found.overview;
        if (isPlaceholderTitle(ep.title) && found.name) ep.title = found.name;
      }
    }
  }
}

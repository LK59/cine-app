import { createTmdbClient } from "@/lib/clients/tmdb";
import { withPersistentCache } from "@/lib/server-cache";
import { getTmdbLocale, type Locale } from "@/lib/i18n";
import { HttpError } from "@/lib/http";
import type { SonarrEpisodeText } from "@/lib/server-cache";
import { fileKey } from "@/lib/episodeDisplay";

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

/**
 * Les épisodes d'une saison chez TMDB, dans une langue, gardés une semaine sur le disque. Lu aussi par
 * le contrôle de la bibliothèque (§90), qui s'en sert d'arbitre — jamais pour écrire un épisode.
 */
export async function seasonText(tmdbTvId: number, seasonNumber: number, lang: string): Promise<SeasonText> {
  const episodes = await withPersistentCache(`tmdb:season-text:${lang}:${tmdbTvId}:${seasonNumber}`, WEEK_MS, async () => {
    // Une saison que TMDB n'a pas (404) n'apporte rien, et le dit pour la semaine : sans quoi chaque
    // ouverture de la fiche la redemandait. *La casa de papel* : cinq saisons sur le disque, trois
    // chez TMDB, rangées autrement (14/10/2026). Toute autre panne traverse, et n'est pas gardée.
    const data = await createTmdbClient(lang)
      .getTvSeason(tmdbTvId, seasonNumber)
      .catch((err: unknown) => {
        if (err instanceof HttpError && err.status === 404) return { episodes: [] };
        throw err;
      });
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

/**
 * Le titre et le résumé d'un épisode précis chez TMDB — dans la langue de qui regarde, puis en
 * anglais. Rien si TMDB n'a pas la saison, ni l'épisode dans la saison.
 */
async function tmdbEpisodeText(tmdbTvId: number, seasonNumber: number, episodeNumber: number, locale: Locale): Promise<{ name?: string; overview?: string }> {
  const out: { name?: string; overview?: string } = {};
  for (const lang of [...new Set([getTmdbLocale(locale), "en-US"])]) {
    const found = (await seasonText(tmdbTvId, seasonNumber, lang).catch(() => null))?.get(episodeNumber);
    out.name ??= found?.name;
    out.overview ??= found?.overview;
  }
  return out;
}

/** Un titre que Sonarr laisse en attente (« TBA ») n'en est pas un. */
const isSonarrPending = (title: string) => /^(tba|tbd)$/i.test(title.trim());

/**
 * Le texte d'un épisode d'une série Sonarr, selon la règle de vérité (DECISIONS.md §89) : **qui**
 * est cet épisode, c'est Sonarr qui le dit, par le fichier qu'il lui a rattaché (épisode ↔ fichier) ;
 * Jellyfin voit le même fichier.
 *
 * - Sonarr a rattaché ce fichier au **même** épisode (saison, numéro) que Jellyfin, et Jellyfin
 *   identifie la série comme Sonarr (`jellyfinAgrees`) : le texte de Jellyfin est celui de cet
 *   épisode, déjà dans la langue de la bibliothèque — gardé, et complété plus tard comme avant.
 * - Sinon — un autre numéro, ou une série que Jellyfin a prise pour une autre (*The Seven Deadly
 *   Sins* lue comme sa suite, 14/10/2026) : le texte de **l'épisode de Sonarr**, par TMDB au TMDB de
 *   Sonarr (langue de qui regarde, puis anglais), à défaut celui de Sonarr lui-même (en anglais). Le
 *   numéro affiché reste celui du disque.
 * - Un fichier que Sonarr n'a pas rattaché : celui de Jellyfin, inchangé.
 *
 * Rend les épisodes ainsi réglés : `fillEpisodeText` ne doit pas les compléter par leur numéro de
 * disque, qui n'est pas celui de l'épisode.
 */
export async function applyAttachedEpisodeText<T extends EpisodeText & { path?: string | null }>(
  episodes: T[],
  attached: readonly SonarrEpisodeText[],
  sonarrTmdbId: number | null | undefined,
  jellyfinAgrees: boolean,
  locale: Locale
): Promise<Set<T>> {
  const resolved = new Set<T>();
  if (attached.length === 0) return resolved;
  const byFile = new Map<string, SonarrEpisodeText[]>();
  for (const a of attached) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  for (const ep of episodes) {
    const key = fileKey(ep.path);
    const candidates = key ? byFile.get(key) : undefined;
    if (!candidates?.length) continue;
    const same = candidates.find((a) => a.season === ep.seasonNumber && a.episode === ep.episodeNumber);
    if (same && jellyfinAgrees) continue;
    const target = same ?? candidates[0];
    const fromTmdb = sonarrTmdbId ? await tmdbEpisodeText(sonarrTmdbId, target.season, target.episode, locale) : {};
    const sonarrTitle = target.title && !isSonarrPending(target.title) && !isPlaceholderTitle(target.title) ? target.title : undefined;
    ep.title = fromTmdb.name ?? sonarrTitle ?? ep.title;
    ep.overview = fromTmdb.overview ?? target.overview ?? null;
    resolved.add(ep);
  }
  return resolved;
}

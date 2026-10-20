import { getDb } from "@/lib/db";

/**
 * La langue du son retenue par série (20/10/2026, règle de Louis).
 *
 * Changer de langue à la main dans deux épisodes différents d'une même série, vers la même langue,
 * en fait la langue d'ouverture de cette série pour ce compte — à la place de la préférence du compte.
 * Réversible de la même façon : deux épisodes passés à la main vers une autre langue la remplacent.
 *
 * Pourquoi par série et pas une préférence du compte à changer : Augustine passait de l'anglais au
 * français 35 fois en onze jours — mais seulement sur le Mac (The Handmaid's Tale, Obi-Wan, Shōgun),
 * et regardait Lucifer et The Rookie en anglais sur l'iPhone, 41 fois sur 41. Changer la langue du
 * compte aurait déplacé le problème sur l'autre série.
 *
 * Une seule réponse, côté serveur : `playback-state` la donne au lecteur natif comme langue demandée.
 * Les deux lecteurs signalent leurs changements à la main (`POST /api/player/series-language`).
 */

/** Ce qu'on retient pour un compte et une série. */
export interface SeriesLanguageState {
  /** La langue d'ouverture de la série, code Jellyfin (« fra », « eng »), ou `null` : celle du compte. */
  preferred: string | null;
  /** La langue vers laquelle on a changé récemment, pas encore retenue. */
  candidate: string | null;
  /** Les épisodes où ce changement a été fait — deux différents la retiennent. */
  candidateEpisodes: string[];
}

export const EMPTY_SERIES_LANGUAGE: SeriesLanguageState = { preferred: null, candidate: null, candidateEpisodes: [] };

/** Deux épisodes différents. */
export const EPISODES_TO_ADOPT = 2;

/**
 * Un changement de langue fait à la main dans l'épisode `episodeId`, vers `language`.
 *
 * - Vers la langue déjà retenue : rien n'est en train de changer, le candidat en cours tombe.
 * - Vers la langue candidate : un épisode de plus ; au deuxième épisode différent, elle est retenue.
 * - Vers une autre langue : elle devient la candidate, avec cet épisode seulement.
 */
export function nextSeriesLanguage(state: SeriesLanguageState, episodeId: string, language: string): SeriesLanguageState {
  if (language === state.preferred) return { ...state, candidate: null, candidateEpisodes: [] };
  if (language === state.candidate) {
    const episodes = state.candidateEpisodes.includes(episodeId) ? state.candidateEpisodes : [...state.candidateEpisodes, episodeId];
    if (episodes.length >= EPISODES_TO_ADOPT) return { preferred: language, candidate: null, candidateEpisodes: [] };
    return { ...state, candidateEpisodes: episodes };
  }
  return { ...state, candidate: language, candidateEpisodes: [episodeId] };
}

const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;
/** Un code de langue tel que Jellyfin les écrit — rien d'autre n'entre dans la table. */
export function isLanguageCode(value: unknown): value is string {
  return typeof value === "string" && LANGUAGE.test(value);
}

interface Row {
  preferred: string | null;
  candidate: string | null;
  candidate_episodes: string | null;
}

function parse(row: Row | undefined): SeriesLanguageState {
  if (!row) return EMPTY_SERIES_LANGUAGE;
  let episodes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.candidate_episodes ?? "[]");
    if (Array.isArray(parsed)) episodes = parsed.filter((e): e is string => typeof e === "string");
  } catch {
    episodes = [];
  }
  return { preferred: row.preferred, candidate: row.candidate, candidateEpisodes: episodes };
}

export function readSeriesLanguage(account: string, seriesId: string): SeriesLanguageState {
  const row = getDb()
    .prepare("SELECT preferred, candidate, candidate_episodes FROM series_audio_language WHERE account = ? AND series_id = ?")
    .get(account, seriesId) as Row | undefined;
  return parse(row);
}

/** La langue d'ouverture retenue pour cette série, ou `null` : la préférence du compte s'applique. */
export function seriesPreferredLanguage(account: string, seriesId: string): string | null {
  return readSeriesLanguage(account, seriesId).preferred;
}

/** Note un changement à la main et rend l'état qui en résulte. */
export function recordSeriesLanguageChoice(account: string, seriesId: string, episodeId: string, language: string, now = Date.now()): SeriesLanguageState {
  const db = getDb();
  return db.transaction(() => {
    const next = nextSeriesLanguage(readSeriesLanguage(account, seriesId), episodeId, language);
    db.prepare(
      `INSERT INTO series_audio_language (account, series_id, preferred, candidate, candidate_episodes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, series_id) DO UPDATE SET preferred = excluded.preferred, candidate = excluded.candidate,
         candidate_episodes = excluded.candidate_episodes, updated_at = excluded.updated_at`
    ).run(account, seriesId, next.preferred, next.candidate, JSON.stringify(next.candidateEpisodes), now);
    return next;
  })();
}

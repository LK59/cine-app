/**
 * L'ordre de la rangée « Reprendre » : le dernier lu d'abord, films et épisodes mêlés (28/09/2026).
 *
 * La rangée mettait bout à bout deux flux : les films du flux « Reprendre », puis les épisodes
 * d'« À suivre », chacun dans son ordre. Un film laissé il y a deux jours passait donc toujours
 * devant l'épisode lancé il y a cinq minutes, et aucun rafraîchissement n'y changeait rien. Et
 * l'ordre d'« À suivre » selon Jellyfin n'est pas celui de la dernière lecture (relevé le même jour :
 * Ted Lasso devant Mr. Robot, lu une minute plus tard).
 *
 * Une seule fonction, lue par le cinéma du bureau et celui du téléphone (DECISIONS.md, § 33). Chaque
 * carte porte `lastPlayedAt`, que les routes lisent chez Jellyfin ; un épisode jamais ouvert (le
 * suivant d'une série) prend celle du dernier épisode lu de sa série. Sans date, une carte garde sa
 * place relative, après les datées — les films avant les épisodes, comme avant.
 */

export interface ContinueMovie {
  id: string;
  lastPlayedAt?: string | null;
}

export interface ContinueEpisode {
  jellyfinItemId: string;
  lastPlayedAt?: string | null;
}

export type ContinueEntry<M extends ContinueMovie, E extends ContinueEpisode> =
  | { kind: "movie"; key: string; item: M }
  | { kind: "episode"; key: string; item: E };

function time(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function continueOrder<M extends ContinueMovie, E extends ContinueEpisode>(movies: M[], episodes: E[]): ContinueEntry<M, E>[] {
  const entries: ContinueEntry<M, E>[] = [
    ...movies.map((item) => ({ kind: "movie" as const, key: item.id, item })),
    ...episodes.map((item) => ({ kind: "episode" as const, key: item.jellyfinItemId, item })),
  ];
  // Stable : à date égale (ou absente), l'ordre des flux.
  return entries
    .map((entry, index) => ({ entry, index, at: time(entry.item.lastPlayedAt) }))
    .sort((a, b) => (b.at === a.at ? a.index - b.index : b.at - a.at))
    .map(({ entry }) => entry);
}

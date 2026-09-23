/**
 * L'ordre des saisons d'une série, et celle qu'on ouvre — une seule écriture pour les deux écrans.
 *
 * La route des épisodes range les épisodes spéciaux (saison 0) en dernier, exprès ; les deux
 * fiches réunissaient ensuite les saisons possédées et manquantes, et les retriaient par numéro —
 * ce qui remettait « Épisodes spéciaux » en tête. Le téléphone ouvrait donc la série dessus, le
 * bureau ouvrait la saison 1 avec les spéciaux affichés au-dessus : deux décisions différentes
 * pour la même série (relevé le 23/09/2026).
 */
export function orderSeasons(numbers: Iterable<number>): number[] {
  return [...new Set(numbers)].sort((a, b) => Number(a === 0) - Number(b === 0) || a - b);
}

/** La saison ouverte par défaut : la première qui n'est pas celle des spéciaux, s'il y en a une. */
export function defaultSeason(numbers: Iterable<number>): number | null {
  return orderSeasons(numbers)[0] ?? null;
}

/**
 * Le nombre affiché sur la pastille d'une saison : les épisodes qui *manquent*.
 *
 * Il comptait aussi ceux qui ne sont pas encore sortis — « 10 » sur une saison annoncée dont
 * aucun épisode n'est diffusé, alors que l'en-tête juste en dessous disait « 10 épisodes à venir ».
 */
export function missingCount(season: { episodes: { released: boolean }[] } | undefined): number {
  return season?.episodes.filter((ep) => ep.released).length ?? 0;
}

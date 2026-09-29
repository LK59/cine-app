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
 * La saison qu'une fiche ouvre : la première *possédée* (règle de `defaultSeason`), et une saison
 * manquante seulement quand on n'en possède aucune.
 *
 * Les deux écrans en décidaient chacun : le bureau sur les saisons possédées, le téléphone sur la
 * réunion des possédées et des manquantes signalées par Sonarr. Une série dont seule la saison 15
 * est là ouvrait la 15 sur le bureau ; le téléphone l'ouvrait aussi, puis sautait à la 1 — vide —
 * quand la réponse des manquants arrivait (29/09/2026). Ouvrir une saison qu'on ne peut pas
 * regarder n'a pas de sens tant qu'il en existe une qu'on peut.
 *
 * Le choix se fait une fois : l'appelant le fige à la première réponse qui le permet.
 */
export function openingSeason(owned: Iterable<number>, missing: Iterable<number>): number | null {
  return defaultSeason(owned) ?? defaultSeason(missing);
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

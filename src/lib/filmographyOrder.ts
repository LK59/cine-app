/**
 * L'ordre d'une filmographie (fiche personne, DECISIONS.md §98).
 *
 * Elle était triée par note moyenne seule : un documentaire noté 10 par **une** personne passait
 * devant un film noté 7,9 par 20 000. Relevé sur Tom Hanks (15/10/2026) : après ses 13 titres de la
 * bibliothèque venaient « Nos Bastidores de Hollywood — Self (archive footage) », « The Last Mile —
 * Self », des talk-shows… *Seul au monde* n'arrivait qu'en 37ᵉ position ; 158 des 270 entrées étaient
 * des apparitions.
 *
 * Trois clés, dans l'ordre :
 *  1. dans la bibliothèque d'abord (inchangé : la fiche les montre à part) ;
 *  2. un vrai rôle avant une apparition (`isAppearance`) ;
 *  3. la note pondérée par le nombre de votes — la moyenne bayésienne d'IMDb : un titre peu voté
 *     tend vers une note moyenne (`PRIOR_MEAN`) au lieu de passer devant tout le monde.
 * Pas la popularité TMDB : elle mesure ce qui est regardé cette semaine (un talk-show d'hier
 * l'emporte sur un classique) et changerait l'ordre d'un jour à l'autre.
 */

/** Le poids de la note a priori, en votes : à 500 votes, la note du titre ne compte qu'à moitié. */
export const PRIOR_VOTES = 500;
/** La note vers laquelle tend un titre peu voté. */
export const PRIOR_MEAN = 6;

/** Talk-show (10767) et actualités (10763) : des plateaux, pas des rôles. */
const APPEARANCE_GENRES = new Set([10767, 10763]);

/**
 * Une apparition plutôt qu'un rôle : « Self », « Himself », « Herself » (souvent suivis de
 * « - Guest », « (archive footage) »…), les images d'archives, les plateaux télé. Le personnage
 * vient de TMDB en anglais quelle que soit la langue demandée ; les formes françaises,
 * espagnoles et allemandes couvrent les fiches saisies autrement.
 */
export function isAppearance(c: { character?: string | null; genreIds?: readonly number[] | null }): boolean {
  const ch = (c.character ?? "").trim();
  if (/^(self|himself|herself|themselves|themself|lui-même|elle-même|él mismo|ella misma|sí mismo|sich selbst)(?![\p{L}])/iu.test(ch)) return true;
  if (/archive footage|images d'archives|material de archivo|archivmaterial/i.test(ch)) return true;
  return (c.genreIds ?? []).some((g) => APPEARANCE_GENRES.has(g));
}

/** La note pondérée par le nombre de votes (moyenne bayésienne). */
export function weightedRating(voteAverage: number | null | undefined, voteCount: number | null | undefined): number {
  const v = Math.max(0, voteCount ?? 0);
  const r = voteAverage ?? 0;
  return (v * r + PRIOR_VOTES * PRIOR_MEAN) / (v + PRIOR_VOTES);
}

export interface OrderableCredit {
  inLibrary: boolean;
  character?: string | null;
  genreIds?: readonly number[] | null;
  voteAverage: number;
  voteCount?: number | null;
}

/** Trie une copie, dans l'ordre décrit plus haut. */
export function sortFilmography<T extends OrderableCredit>(credits: readonly T[]): T[] {
  const keyed = credits.map((c) => ({ c, appearance: isAppearance(c), score: weightedRating(c.voteAverage, c.voteCount) }));
  keyed.sort((a, b) => {
    if (a.c.inLibrary !== b.c.inLibrary) return a.c.inLibrary ? -1 : 1;
    if (a.appearance !== b.appearance) return a.appearance ? 1 : -1;
    return b.score - a.score;
  });
  return keyed.map((k) => k.c);
}

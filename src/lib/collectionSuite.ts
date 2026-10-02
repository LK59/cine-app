/**
 * « La suite » : le film d'une saga à proposer quand le précédent se termine.
 *
 * La règle, écrite une fois : dans l'ordre de la saga — celui de la rangée de la fiche
 * (`useCinemaCollection`), qui est celui de la collection TMDB —, le premier film **après** celui
 * qui vient de finir, que cet écran sait ouvrir (dans le catalogue du cinéma) et que le spectateur
 * n'a pas vu. « Vu » est celui de Jellyfin (`useJellyfinItemState`), jamais une copie. Rien sinon :
 * pas de suite pour le dernier de la saga, ni pour un film hors saga, ni quand tout ce qui suit a
 * été vu — et jamais un film d'avant, qui serait un retour en arrière et non une suite.
 *
 * L'état « vu » arrive titre par titre. La fonction dit donc aussi sur quel titre elle attend
 * (`ask`) : l'écran de fin le demande, puis la rappelle avec la réponse — un film vu ne coûte que
 * la question suivante, et la décision reste ici, entière. DECISIONS.md §44.
 */

/** Ce que la décision lit d'un film de la saga : de quoi l'identifier et l'ouvrir. */
export interface SuitePart<M extends { radarrId: number; jellyfinItemId: string }> {
  /** Le titre du catalogue de cet écran, ou `null` quand il ne sait pas l'ouvrir. */
  movie: M | null;
}

export type CollectionSuite<M> =
  /** Rien à proposer. */
  | { kind: "none" }
  /** On ne sait pas encore si ce film a été vu : demander, puis rappeler. */
  | { kind: "ask"; movie: M }
  /** La suite. */
  | { kind: "next"; movie: M };

/**
 * @param parts la saga entière, dans son ordre, le film qui finit compris
 * @param currentRadarrId le film qui vient de finir
 * @param watched « vu » par identifiant Jellyfin, pour ce qu'on en sait déjà
 */
export function collectionSuite<M extends { radarrId: number; jellyfinItemId: string }>(
  parts: readonly SuitePart<M>[],
  currentRadarrId: number | null,
  watched: Readonly<Record<string, boolean>>
): CollectionSuite<M> {
  if (currentRadarrId === null) return { kind: "none" };
  const at = parts.findIndex((part) => part.movie?.radarrId === currentRadarrId);
  // Hors de la saga — ou la saga ne le connaît pas : rien.
  if (at === -1) return { kind: "none" };
  for (const part of parts.slice(at + 1)) {
    // Un film qu'on n'a pas ne se lance pas d'ici : la rangée de la fiche le montre, pas l'écran de fin.
    if (!part.movie) continue;
    const seen = watched[part.movie.jellyfinItemId];
    if (seen === undefined) return { kind: "ask", movie: part.movie };
    if (!seen) return { kind: "next", movie: part.movie };
  }
  return { kind: "none" };
}

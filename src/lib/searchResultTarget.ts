import type { UnifiedSearchResult } from "@/app/api/search/route";

/**
 * La fiche de bibliothèque d'un résultat de recherche, ou `null` pour sa fiche TMDB.
 *
 * Un titre que Radarr ou Sonarr suit sans l'avoir encore — un film en salle, une série dont aucun
 * épisode n'est arrivé — n'est pas dans le catalogue du cinéma : sa fiche de bibliothèque ne le
 * trouvait pas et se refermait aussitôt, sans un mot (L'Odyssée, 24/09/2026). Il s'ouvre donc
 * comme un titre qu'on n'a pas, sur sa fiche TMDB, qui dit où en est la demande.
 *
 * Une seule règle pour tous les endroits du cinéma qui ouvrent un résultat de `/api/search`.
 * `available` absent — une réponse d'avant ce champ — ne retire rien : le comportement d'avant.
 */
export function libraryTargetOf(result: Pick<UnifiedSearchResult, "type" | "radarrId" | "sonarrId"> & { available?: boolean }): number | null {
  if (result.available === false) return null;
  return result.type === "movie" ? result.radarrId : result.sonarrId;
}

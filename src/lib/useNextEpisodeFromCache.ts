import { useCallback } from "react";
import { useSWRConfig } from "swr";
import type { CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import { nextEpisodeIn } from "@/lib/nextEpisode";

// À part de `nextEpisode.ts`, que la route des épisodes importe côté serveur : `useSWRConfig`
// n'existe pas dans la version serveur de SWR, et le build de production s'y arrêtait.

/**
 * L'épisode suivant, lu dans la liste des épisodes **au moment où on le demande**.
 *
 * Depuis que le bouton d'une fiche s'affiche avant l'arrivée de la liste des épisodes (`sheetFacts`,
 * 25/09/2026), un Lire appuyé tout de suite emportait `nextEpisodeIn([])` : au générique, ni
 * « Épisode suivant » ni enchaînement, et `advance` gardait la même fonction pour toute la séance
 * (chasse aux défauts du 25/09/2026). Relue dans la réserve de SWR à chaque appel, la liste arrivée
 * entre-temps compte.
 */
export function useNextEpisodeFromCache(episodesKey: string): (currentItemId: string) => { itemId: string; title: string } | null {
  const { cache } = useSWRConfig();
  return useCallback(
    (currentItemId: string) => {
      const data = cache.get(episodesKey)?.data as { seasons?: CinemaSeason[] } | undefined;
      return nextEpisodeIn(data?.seasons ?? [])(currentItemId);
    },
    [cache, episodesKey]
  );
}

"use client";

import useSWR from "swr";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";
import type { PlayerItemPayload } from "@/app/api/player/item/[itemId]/route";

/**
 * Ce que le lecteur sait d'un titre à côté du film (`/api/player/item`) : la série d'un épisode, pour
 * le menu « Épisodes », et le droit de télécharger avec la taille du fichier (19/10/2026).
 *
 * Demandé pendant que le film a l'écran : sans `playerBootstrapOptions`, SWR — en pause tant qu'un
 * film est plein écran — laissait tomber la requête, et aucun des deux gestes n'apparaissait jamais.
 * Une fois par titre, sans relecture au retour sur la page : rien de cela ne change en cours de film.
 */
export function usePlayerItem(itemId: string): PlayerItemPayload | null {
  const { data } = useSWR<PlayerItemPayload>(`/api/player/item/${itemId}`, fetcher, {
    ...playerBootstrapOptions,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    shouldRetryOnError: false,
  });
  return data ?? null;
}

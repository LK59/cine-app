"use client";

import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { preloadQuietly } from "@/lib/prefetch";
import { usePlayerEnabled, usePlayerServerFallback } from "@/lib/usePlayerEnabled";
import { useLegacyPlayer } from "@/lib/useLegacyPlayer";
import { directInfoKey, prefetchPlaybackState } from "@/lib/playbackPrefetch";

/**
 * La fiche ouverte prépare ce que « Lire » va demander — la seule fonction qui le fait.
 *
 * Appelée par chaque fiche avec le titre que son bouton principal lancerait : le film, ou
 * l'épisode à reprendre. **Jamais par une carte ni par une ligne d'épisode** : une grille en
 * montre des dizaines, et ce serait une rafale de requêtes pour des titres que personne n'ouvre.
 * Voir `DECISIONS.md`, « Ce que Lire trouve déjà prêt ».
 *
 * Deux réponses :
 * - la description du fichier, glissée dans SWR par `preload` — l'hôte la lit sous la même clé et
 *   reprend la demande en vol au lieu d'en lancer une autre ; gardée ensuite toute la session,
 *   comme l'hôte le faisait déjà ;
 * - l'état du spectateur, gardé trente secondes et pris une seule fois — voir `playbackPrefetch.ts`.
 *
 * Seulement quand c'est le lecteur natif qui ouvrira : le lecteur serveur ne lit ni l'une ni
 * l'autre, et la route `direct` refuse un compte qui l'a choisi.
 */
export function usePlaybackPrefetch(itemId: string | null | undefined): void {
  const enabled = usePlayerEnabled();
  const serverFallback = usePlayerServerFallback();
  const { legacy } = useLegacyPlayer();
  const { cache, mutate } = useSWRConfig();
  // La même règle que `PlayerHost` : sans lecteur serveur, tout va au natif ; sinon, le compte
  // décide. Une réponse pas encore arrivée ne prépare rien — mieux vaut rien qu'une requête pour
  // un lecteur qui ne s'ouvrira pas.
  const native = serverFallback === false || (serverFallback === true && legacy === false);

  useEffect(() => {
    if (!enabled || !native || !itemId) return;
    prefetchPlaybackState(itemId);
    const key = directInfoKey(itemId);
    if (cache.get(key)?.data !== undefined) return;
    // Un échec ne doit pas rester dans la réserve de SWR : l'hôte le prendrait, une heure plus
    // tard, pour la réponse du moment. `mutate(key)` sans donnée l'en retire (et relance l'hôte
    // s'il était déjà là à attendre). `preloadQuietly` rend `undefined` sur un échec.
    void preloadQuietly(key).then((data) => {
      if (data === undefined) void mutate(key);
    });
  }, [enabled, native, itemId, cache, mutate]);
}

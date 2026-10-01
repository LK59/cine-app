"use client";

import { useEffect } from "react";
import { fetchDirectInfo } from "@/lib/directInfo";
import { clearFileMissing, isFileMissing, markFileMissing } from "@/lib/missingFiles";
import { usePlayerEnabled, usePlayerServerFallback } from "@/lib/usePlayerEnabled";
import { useLegacyPlayer } from "@/lib/useLegacyPlayer";
import { prefetchPlaybackState } from "@/lib/playbackPrefetch";

/**
 * La fiche ouverte prépare ce que « Lire » va demander — la seule fonction qui le fait.
 *
 * Appelée par chaque fiche avec le titre que son bouton principal lancerait : le film, ou
 * l'épisode à reprendre. **Jamais par une carte ni par une ligne d'épisode** : une grille en
 * montre des dizaines, et ce serait une rafale de requêtes pour des titres que personne n'ouvre.
 * Voir `DECISIONS.md`, « Ce que Lire trouve déjà prêt ».
 *
 * Deux réponses :
 * - la description du fichier, gardée cinq minutes (`directInfo.ts`) — l'hôte reprend la demande en
 *   vol au lieu d'en lancer une autre. Plus « toute la session » : elle porte la taille et l'ETag du
 *   fichier, et un fichier remplacé entre-temps s'ouvrait sur ses anciens octets (30/09/2026) ;
 * - l'état du spectateur, gardé trente secondes et pris une seule fois — voir `playbackPrefetch.ts`.
 *
 * Seulement quand c'est le lecteur natif qui ouvrira : le lecteur serveur ne lit ni l'une ni
 * l'autre, et la route `direct` refuse un compte qui l'a choisi.
 */
export function usePlaybackPrefetch(itemId: string | null | undefined): void {
  const enabled = usePlayerEnabled();
  const serverFallback = usePlayerServerFallback();
  const { legacy } = useLegacyPlayer();
  // La même règle que `PlayerHost` : sans lecteur serveur, tout va au natif ; sinon, le compte
  // décide. Une réponse pas encore arrivée ne prépare rien — mieux vaut rien qu'une requête pour
  // un lecteur qui ne s'ouvrira pas.
  const native = serverFallback === false || (serverFallback === true && legacy === false);

  useEffect(() => {
    if (!enabled || !native || !itemId) return;
    prefetchPlaybackState(itemId);
    // Un échec n'est pas gardé (`fetchDirectInfo`) : l'hôte reposera la question. Et sa nature est
    // retenue : si Jellyfin a répondu que le fichier n'existe plus, la fiche grise son bouton Lire —
    // seulement dans ce cas, jamais pour une coupure (voir `missingFiles.ts`).
    fetchDirectInfo(itemId).then(
      () => clearFileMissing(itemId),
      (error: unknown) => {
        if (isFileMissing(error)) markFileMissing(itemId);
      }
    );
  }, [enabled, native, itemId]);
}

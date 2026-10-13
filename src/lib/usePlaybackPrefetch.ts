"use client";

import { useEffect } from "react";
import { fetchDirectInfo } from "@/lib/directInfo";
import { clearFileMissing, isFileMissing, markFileMissing } from "@/lib/missingFiles";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
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
 * Toujours, depuis le 13/10/2026 : le lecteur natif est le chemin de chaque ouverture. Le choix
 * « lecteur legacy » d'un compte, qui envoyait toutes ses lectures au lecteur serveur (lequel ne lit
 * ni l'une ni l'autre), a disparu — il n'y a plus de réponse à attendre avant de préparer.
 */
export function usePlaybackPrefetch(itemId: string | null | undefined): void {
  const enabled = usePlayerEnabled();

  useEffect(() => {
    if (!enabled || !itemId) return;
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
  }, [enabled, itemId]);
}

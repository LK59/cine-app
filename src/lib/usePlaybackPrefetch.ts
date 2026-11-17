"use client";

import { useEffect } from "react";
import { fetchDirectInfo } from "@/lib/directInfo";
import { clearFileMissing, isFileMissing, markFileMissing } from "@/lib/missingFiles";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
import { prefetchPlaybackState } from "@/lib/playbackPrefetch";
import { scheduleSheetHeaderWarmup } from "@/lib/sheetHeaderWarmup";
import { usePlaybackMode } from "@/components/PlaybackProvider";

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
 * Et depuis le 28/10/2026, après une seconde de fiche, l'en-tête et l'index du fichier lui-même
 * (`sheetHeaderWarmup.ts`) — dans un effet à part : il s'arrête quand un film s'ouvre, et le
 * relancer à la fermeture du film ne doit pas redemander l'état du spectateur, qui serait lu avant
 * que l'arrêt n'ait écrit la nouvelle position.
 *
 * Toujours, depuis le 13/10/2026 : le lecteur natif est le chemin de chaque ouverture. Le choix
 * « lecteur legacy » d'un compte, qui envoyait toutes ses lectures au lecteur serveur (lequel ne lit
 * ni l'une ni l'autre), a disparu — il n'y a plus de réponse à attendre avant de préparer.
 */
export function usePlaybackPrefetch(itemId: string | null | undefined): void {
  const enabled = usePlayerEnabled();
  // Plein écran ou réduit : le réseau est au film.
  const filmOpen = usePlaybackMode() !== "closed";

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

  useEffect(() => {
    if (!enabled || !itemId || filmOpen) return;
    return scheduleSheetHeaderWarmup(itemId);
  }, [enabled, itemId, filmOpen]);
}

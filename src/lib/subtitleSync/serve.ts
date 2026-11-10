import { jellyfin } from "@/lib/clients/jellyfin";
import { subtitleTrackKey, type SubtitleSync } from "@/lib/subtitleSync";
import { appliedFor } from "./store";

/**
 * La correction appliquée à une piste servie par la route des sous-titres (DECISIONS.md §141), pour la version
 * **actuelle** du fichier : la source et la piste sont relues chez Jellyfin (clé du serveur) — l'`ETag` dit si la
 * mesure vaut encore, le chemin d'un fichier à côté donne sa clé. Appelée seulement quand l'adresse porte `&sync=` ;
 * `null` au moindre doute (Jellyfin muet, piste inconnue, fichier changé) : le WebVTT part alors tel quel.
 */
export async function syncForSubtitleStream(itemId: string, mediaSourceId: string, index: number): Promise<SubtitleSync | null> {
  try {
    const [item] = await jellyfin.getItemsWithStreams([itemId]);
    const source = item?.MediaSources?.find((s) => s.Id?.toLowerCase() === mediaSourceId.toLowerCase()) ?? item?.MediaSources?.[0];
    const stream = source?.MediaStreams?.find((s) => s.Type === "Subtitle" && s.Index === index);
    const key = stream ? subtitleTrackKey(stream) : null;
    if (!source || !key) return null;
    const sync = appliedFor(itemId, source.ETag).get(key);
    return sync ? { offset: sync.offset, scale: sync.scale } : null;
  } catch {
    return null;
  }
}

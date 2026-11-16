import type { JellyfinMediaSource } from "@/lib/clients/jellyfin";
import { CAST_TOKEN_PARAM } from "@/lib/castToken";
import type { SubtitleSync } from "@/lib/subtitleSync";

/**
 * Les sous-titres d'un fichier tels que les lecteurs à `<track>` les reçoivent : les **faits** de chaque
 * piste (l'étiquette se construit dans le navigateur, `serverTracks.ts`) et l'adresse WebVTT de la route
 * des sous-titres (`/api/jellyfin/stream/subtitle/…`, qui demande à Jellyfin la conversion).
 *
 * Écrite une fois pour ses deux appelants (DECISIONS.md §180) : la négociation du lecteur serveur
 * (`/api/jellyfin/playback/start`), d'où elle est sortie telle quelle — clés dans le même ordre, mêmes
 * conditions —, et Lumen serveur (`/api/lumen/{id}/pistes`), qui ne négocie rien avec Jellyfin mais pose
 * les mêmes `<track>`. Deux copies auraient divergé au premier champ ajouté — l'aide d'un passage rejoué
 * (§150) lit `isText`, la synchro (§141) `&sync=`.
 *
 * - `syncByIndex` : les corrections de synchro appliquées (§141), par index Jellyfin ; la route des
 *   sous-titres réécrit le WebVTT quand l'adresse porte `&sync=` (sa version).
 * - `castPass` : le laissez-passer d'un téléviseur, porté par chaque adresse (lecteur serveur seulement).
 * - `castTarget` : un Chromecast lit `isText` pour chaque piste (une piste texte s'allume sans relancer le
 *   flux). Ailleurs, `isText: false` seulement pour une piste en images ; une piste texte reste sans le
 *   champ — la réponse d'avant le 13/11/2026.
 */
export function subtitleTrackFacts(
  itemId: string,
  source: Pick<JellyfinMediaSource, "Id" | "MediaStreams">,
  options: {
    syncByIndex?: Record<string, SubtitleSync & { version: number }> | undefined;
    castPass?: string | null;
    castTarget?: boolean;
  } = {}
) {
  const { syncByIndex, castPass, castTarget } = options;
  return (source.MediaStreams ?? [])
    .filter((s) => s.Type === "Subtitle")
    .map((s) => ({
      index: s.Index,
      language: s.Language ?? null,
      title: s.Title ?? null,
      isDefault: s.IsDefault ?? false,
      isForced: s.IsForced ?? false,
      isHearingImpaired: s.IsHearingImpaired ?? false,
      isExternal: s.IsExternal ?? false,
      ...(castTarget ? { isText: s.IsTextSubtitleStream ?? null } : s.IsTextSubtitleStream === false ? { isText: false } : {}),
      url:
        `/api/jellyfin/stream/subtitle/${itemId}?mediaSourceId=${source.Id}&index=${s.Index}` +
        (syncByIndex?.[String(s.Index)] ? `&sync=${syncByIndex[String(s.Index)].version}` : "") +
        (castPass ? `&${CAST_TOKEN_PARAM}=${encodeURIComponent(castPass)}` : ""),
      ...(syncByIndex?.[String(s.Index)]
        ? { sync: { offset: syncByIndex[String(s.Index)].offset, scale: syncByIndex[String(s.Index)].scale } }
        : {}),
    }));
}

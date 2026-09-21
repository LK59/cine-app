import type { EngineTrack } from "./engine";
import type { MatroskaTrack } from "./matroska";

/**
 * Une piste du conteneur, telle que l'interface la voit — la seule conversion.
 *
 * Il y en avait deux, une par chemin, et elles avaient divergé : celle du canevas oubliait le
 * nombre de canaux, dont le choix de piste a besoin pour départager deux pistes d'une même langue,
 * et toutes deux oubliaient le drapeau « malentendants ».
 */
export function fromMatroskaTrack(track: MatroskaTrack): EngineTrack {
  return {
    number: track.number,
    codecId: track.codecId,
    language: track.language,
    name: track.name,
    isDefault: track.isDefault,
    isForced: track.isForced,
    isHearingImpaired: track.isHearingImpaired,
    channels: track.audio?.channels ?? null,
  };
}

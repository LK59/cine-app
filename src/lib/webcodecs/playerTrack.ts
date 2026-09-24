import type { MatroskaTrack } from "./matroska";

/**
 * Une piste du fichier, telle que l'interface la voit : les menus, le choix de piste du compte,
 * les étiquettes. Lue du conteneur par `fromMatroskaTrack`, ou d'un fichier posé à côté du film
 * par `externalSubtitles.ts`.
 *
 * S'appelait `EngineTrack`, du temps où le moteur canevas la produisait aussi (retiré le
 * 24/09/2026 — voir docs/lecteur-canvas.md).
 */
export interface PlayerTrack {
  number: number;
  codecId: string;
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
  /**
   * Le nombre de canaux, quand la piste en a un — nul pour un sous-titre.
   *
   * Porté jusqu'ici pour départager deux pistes audio de la même langue : à défaut, « la
   * meilleure » n'a pas de sens de ce côté de l'application, qui ne voit que des numéros et des
   * noms. Voir `rank` dans `trackPreferences`.
   */
  channels?: number | null;
  /**
   * Sous-titres pour malentendants, lu du drapeau du conteneur — voir `MatroskaTrack`.
   *
   * Absent de cette interface jusqu'au 21/09/2026 : le lecteur natif étiquetait donc « SDH »
   * seulement les pistes dont le *titre* le disait (85 ici), quand le lecteur stable, nourri par
   * Jellyfin, en reconnaissait 112. Les deux lecteurs doivent dire la même chose d'une même piste.
   */
  isHearingImpaired?: boolean;
}

/**
 * Une piste du conteneur, telle que l'interface la voit — la seule conversion.
 *
 * Il y en avait deux, une par chemin, et elles avaient divergé : celle du canevas oubliait le
 * nombre de canaux, dont le choix de piste a besoin pour départager deux pistes d'une même langue,
 * et toutes deux oubliaient le drapeau « malentendants ».
 */
export function fromMatroskaTrack(track: MatroskaTrack): PlayerTrack {
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

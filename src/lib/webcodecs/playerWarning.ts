/**
 * Ce que le lecteur a à dire au spectateur pendant que le film continue — un code, pas une phrase.
 *
 * Le pipeline ne connaît pas la langue de qui regarde : il écrivait ses avertissements en
 * français, et un compte réglé en anglais, en espagnol ou en allemand les lisait tels quels
 * (relevé le 21/09/2026). Il nomme maintenant *ce qui* se passe ; l'écran le dit dans la langue du
 * spectateur (`player.warnings.<code>`), et le détail technique — le codec, la raison donnée par
 * le décodeur — part au journal, où il sert, plutôt qu'à l'écran, où il ne dit rien à personne.
 */
export type PlayerWarningCode =
  /** Pas d'index dans le fichier : un saut n'est pas possible. */
  | "noIndexSeek"
  /** Pas d'index dans le fichier : la piste audio ne peut pas changer en cours de lecture. */
  | "noIndexAudio"
  /** La piste demandée n'a pas pu s'ouvrir ; la précédente continue. */
  | "audioTrackRefused";
// « Pas de son », « son interrompu » et « aucun décodeur » venaient du lecteur canevas, qui
// décodait l'audio lui-même ; retirés avec lui le 24/09/2026. Le lecteur natif rend ces cas au
// lecteur serveur ou reconstruit, sans avertissement.

export interface PlayerWarning {
  code: PlayerWarningCode;
  /** Pour le journal et le rapport : jamais affiché tel quel. */
  detail?: string;
}

export function playerWarning(code: PlayerWarningCode, detail?: string): PlayerWarning {
  return detail ? { code, detail } : { code };
}

const CODES: ReadonlySet<string> = new Set<PlayerWarningCode>([
  "noIndexSeek",
  "noIndexAudio",
  "audioTrackRefused",
]);

/** Ce qui arrive par le rappel `onWarning` du pipeline n'est pas typé : vérifié avant d'être dit. */
export function isPlayerWarning(value: unknown): value is PlayerWarning {
  return typeof value === "object" && value !== null && CODES.has((value as { code?: unknown }).code as string);
}

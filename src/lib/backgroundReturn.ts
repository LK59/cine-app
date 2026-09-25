/**
 * Au retour d'arrière-plan, la lecture reprend-elle d'elle-même ? Non, sauf après un aller-retour
 * de quelques secondes.
 *
 * Verrouiller l'iPhone en plein film suspend la vidéo ; au déverrouillage, WebKit la relance de
 * lui-même (constaté le 25/09/2026 — notre lecteur n'y était pour rien). Or on verrouille souvent
 * parce qu'on est interrompu : un film qui repart seul au retour fait manquer la scène qui suit, ou
 * démarre le son au mauvais moment. C'est ce que font Netflix, YouTube et l'app TV d'Apple : la
 * lecture attend, quelques secondes en arrière pour retrouver le fil.
 *
 * Ce qui n'est pas concerné, et le critère qui le reconnaît sans demander à chaque navigateur ce
 * qu'il sait faire : une vidéo qui a **continué** pendant l'absence — image dans l'image, lecture
 * en arrière-plan — n'a pas été suspendue ; on la laisse.
 */

/** En dessous, un aller-retour rapide vers une autre application : la lecture reprend comme avant. */
export const HOLD_AFTER_AWAY_MS = 5000;
/** Le recul au retour, pour retrouver le fil. */
export const REWIND_ON_RETURN_SECONDS = 3;
/** Au-delà, la vidéo a joué pendant l'absence : elle n'a pas été suspendue. */
const PLAYED_WHILE_AWAY_SECONDS = 2;

export interface ReturnFacts {
  /** La durée de l'absence. */
  awayMs: number;
  /** La vidéo jouait-elle au moment du départ ? */
  playingWhenHidden: boolean;
  /** Sa position au départ et au retour. */
  positionWhenHidden: number;
  positionOnReturn: number;
}

export function holdPausedOnReturn(facts: ReturnFacts): boolean {
  if (!facts.playingWhenHidden || facts.awayMs < HOLD_AFTER_AWAY_MS) return false;
  // Image dans l'image, lecture en arrière-plan : elle a continué, il n'y a rien à reprendre.
  return facts.positionOnReturn - facts.positionWhenHidden < PLAYED_WHILE_AWAY_SECONDS;
}

/** Où reprendre : un peu avant, jamais avant le début. */
export function rewoundPosition(position: number): number {
  return Math.max(0, position - REWIND_ON_RETURN_SECONDS);
}

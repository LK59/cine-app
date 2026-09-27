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

/**
 * Une pause qui précède le départ en arrière-plan de moins que ceci peut être celle d'iOS lui-même,
 * qui suspend la vidéo en verrouillant l'écran : seule une pause plus ancienne est celle du
 * spectateur. La même fenêtre pour les deux décisions qui en dépendent — l'état noté au départ
 * (`BackgroundWatch.hide`) et la reconstruction qui garde la pause (`PlayerLifecycle.restart`).
 */
export const IOS_PAUSE_WINDOW_MS = 1000;

/** Combien de temps, au retour, la relance de WebKit est refusée si aucun geste ne l'a demandée. */
export const REFUSE_RELAUNCH_MS = 2500;

/** La retenue d'un retour : jusqu'à quand refuser la relance, où reprendre, depuis quand. */
export interface ReturnHold {
  until: number;
  at: number;
  since: number;
}

/** Une vidéo telle que l'arrière-plan la voit. */
interface VideoState {
  paused: boolean;
  currentTime: number;
}

/**
 * Ce que l'hôte natif retient des allers-retours en arrière-plan, et ce qu'il en décide.
 *
 * Cinq références de `ExperimentalPlayerHost` portaient ces faits, écrites par autant d'écouteurs :
 * la dernière pause du spectateur, le dernier départ, l'état de la vidéo au départ, la retenue au
 * retour, le dernier geste. Réunies ici le 27/09/2026 (étape 5 du découpage,
 * docs/cycle-de-vie-lecteur.md), **à l'identique** : l'hôte garde les écouteurs, la vidéo, la
 * trace ; il demande à cet objet quoi faire. Aucun comportement ne change — seul un iPhone pourrait
 * juger un changement ici.
 */
export class BackgroundWatch {
  /** Quand le spectateur a mis en pause (page visible, film pas fini) — nul dès que ça rejoue. */
  private viewerPausedAt: number | null = null;
  /** Le dernier passage en arrière-plan. */
  private hiddenAt: number | null = null;
  /** L'état de la vidéo au départ en arrière-plan — voir `holdPausedOnReturn`. */
  private hiddenPlayback: { playing: boolean; at: number } | null = null;
  /**
   * Un retour qui doit laisser la lecture en pause : jusqu'à quand refuser la relance de WebKit, et
   * où reprendre. Une reconstruction au retour (source fermée par iOS) le lit aussi.
   */
  private hold: ReturnHold | null = null;
  /** Le dernier geste du spectateur : une lecture qu'il demande lui-même n'est jamais refusée. */
  private lastGestureAt = 0;

  /** La vidéo rejoue. */
  notePlaying(): void {
    this.viewerPausedAt = null;
  }

  /** La vidéo s'arrête. Une pause ne compte comme celle du spectateur que page visible et film pas fini. */
  notePaused(now: number, facts: { visible: boolean; ended: boolean }): void {
    if (facts.visible && !facts.ended) this.viewerPausedAt = now;
  }

  /** Un geste du spectateur (toucher, touche). */
  noteGesture(now: number): void {
    this.lastGestureAt = now;
  }

  /** Ce que la reconstruction a besoin de savoir pour garder la pause — voir `PlayerLifecycle.restart`. */
  pauseFacts(): { viewerPausedAt: number | null; hiddenAt: number | null } {
    return { viewerPausedAt: this.viewerPausedAt, hiddenAt: this.hiddenAt };
  }

  /** La retenue en cours, s'il y en a une — une reconstruction au retour reprend à sa position, en pause. */
  currentHold(): ReturnHold | null {
    return this.hold;
  }

  /**
   * La page part en arrière-plan.
   *
   * Une retenue d'un retour précédent n'a plus rien à dire : sans relance entre-temps, rien ne
   * l'effaçait, et une source fermée au départ suivant rouvrait à sa vieille position — seize minutes
   * en arrière après un glissement de la barre en pause (chasse aux défauts du 25/09/2026). Et une
   * pause qui précède le départ de moins d'une seconde peut être celle d'iOS : la vidéo comptait
   * alors comme en lecture.
   */
  hide(now: number, video: VideoState | null): void {
    this.hiddenAt = now;
    this.hold = null;
    const pausedAt = this.viewerPausedAt;
    const iosPaused = video?.paused === true && pausedAt !== null && now - pausedAt < IOS_PAUSE_WINDOW_MS;
    this.hiddenPlayback = video ? { playing: !video.paused || iosPaused, at: video.currentTime } : null;
  }

  /**
   * La page revient, après `awayMs` d'absence. Rend la retenue à appliquer — mettre la vidéo en
   * pause et la reculer à `hold.at` —, ou `null` si la lecture doit reprendre comme avant.
   *
   * Verrouillé en plein film : la lecture attend au retour, un peu avant (`holdPausedOnReturn`). Une
   * source que iOS a fermée peut laisser l'élément à zéro : la position au départ vaut mieux qu'une
   * reprise au début du film.
   */
  show(now: number, awayMs: number, video: VideoState | null): ReturnHold | null {
    const before = this.hiddenPlayback;
    this.hiddenPlayback = null;
    if (
      !video ||
      !before ||
      !holdPausedOnReturn({ awayMs, playingWhenHidden: before.playing, positionWhenHidden: before.at, positionOnReturn: video.currentTime })
    ) {
      return null;
    }
    const at = rewoundPosition(video.currentTime > 0 ? video.currentTime : before.at);
    this.hold = { until: now + REFUSE_RELAUNCH_MS, at, since: now };
    return this.hold;
  }

  /**
   * La vidéo démarre (`play`) : faut-il refuser ce démarrage ?
   *
   * La relance de WebKit au déverrouillage arrive après notre pause : refusée tant qu'aucun geste du
   * spectateur ne l'a demandée, et pendant la seule fenêtre de la retenue. Passé cette fenêtre, ou
   * après un geste, la retenue est levée et plus rien n'est refusé.
   */
  refusePlay(now: number): boolean {
    const hold = this.hold;
    if (!hold) return false;
    if (now > hold.until || this.lastGestureAt > hold.since) {
      this.hold = null;
      return false;
    }
    return true;
  }
}

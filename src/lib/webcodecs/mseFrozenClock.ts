// L'horloge figée de `MseSource` : une tête posée sur du média qui ne bouge pas est poussée un peu
// plus loin, trois fois au plus, puis confiée à l'échelle des reprises ; et, une fois par source, la
// position redemandée 100 ms après l'atterrissage de l'ouverture. Sorti de mseSource.ts tel quel,
// constantes comprises dans mseTuning.ts ; la source lui prête une vue étroite d'elle-même
// (`ClockHost`) et garde les événements de l'élément qui le remettent à zéro.

import { trace } from "./trace";
import { rangeAround } from "./timeRanges";
import type { PlaybackGuard } from "./playbackGuard";
import type { SeekLifecycle } from "./seekLifecycle";
import {
  FROZEN_CLOCK_MS, FROZEN_OPENING_MS, FROZEN_SEEKING_MS, FROZEN_STEP, MAX_FROZEN_NUDGES, OPENING_EDGE_SECONDS,
  OPENING_PLAYING_GRACE_MS, OPENING_REASSERT_MS, SEEKING_PATIENCE_PER_SECOND_MS,
} from "./mseTuning";

/**
 * Ce que l'horloge lit de la source. L'avance passe par `MseSource.lead`, la reprise et le passage
 * de main par `MseSource.recover` / `handOver` : appelés à travers l'instance, comme avant.
 */
export interface ClockHost {
  readonly destroyed: boolean;
  readonly video: HTMLVideoElement;
  readonly guard: PlaybackGuard;
  readonly seekState: SeekLifecycle;
  readonly lead: number;
  readonly playable: TimeRanges;
  recover(target: number): boolean;
  handOver(at: number): void;
}

export class FrozenClockWatch {
  constructor(private readonly host: ClockHost) {}

  /** For the frozen-clock check: where the clock was, since when, and how often it was pushed. */
  lastClockAt = -1;
  frozenSince: number | null = null;
  frozenNudges = 0;
  /** Every push over the session, for the `stop` line — the one above resets when the clock moves. */
  frozenNudgesTotal = 0;
  /** La position redemandée une fois après l'atterrissage de l'ouverture — voir `OPENING_REASSERT_MS`. */
  openingReassertTimer: ReturnType<typeof setTimeout> | null = null;
  private openingReassertDone = false;
  /** Le dernier `playing` de l'élément — voir `OPENING_PLAYING_GRACE_MS`. */
  lastPlayingAt = 0;
  /** La poussée de l'ouverture au bout du délai de grâce — voir `armOpeningGracePush`. */
  openingGraceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Le placement de l'ouverture a abouti de lui-même (`playing`, `seeked`) : plus rien à redemander. */
  settleOpeningReassert(): void {
    if (this.openingReassertTimer === null) return;
    clearTimeout(this.openingReassertTimer);
    this.openingReassertTimer = null;
    this.openingReassertDone = true;
  }

  /** Ce que le décodeur traverse depuis le début de la plage sous la tête ; inconnu, le plafond. */
  private decodeDistance(now: number): number {
    const ranges = this.host.playable;
    const i = rangeAround(ranges, now, 0);
    if (i >= 0) return now - ranges.start(i);
    return (FROZEN_SEEKING_MS - FROZEN_CLOCK_MS) / SEEKING_PATIENCE_PER_SECOND_MS;
  }

  /**
   * Arme, une seule fois par source, la position redemandée 100 ms après l'atterrissage de
   * l'ouverture — voir `OPENING_REASSERT_MS`.
   *
   * Seulement pour l'ouverture (la garde attend encore sa première image, près de là où elle s'est
   * ouverte) et seulement au bord du média : une reprise posée loin derrière son image clé décode
   * vraiment, et la relancer recommencerait ce décodage. Le pas est celui de la poussée (+0,08 s),
   * le seul qui ait été vu libérer ce gel ; il est compté comme un placement (`headPlaced`), pas
   * comme de la lecture, et ne consomme pas la poussée de 400 ms, qui reste le filet.
   */
  armOpeningReassert(at: number): void {
    if (this.openingReassertDone || this.openingReassertTimer !== null || this.host.destroyed) return;
    if (!this.host.guard.awaitingFirstPicture || this.decodeDistance(at) >= OPENING_EDGE_SECONDS) return;
    this.openingReassertTimer = setTimeout(() => {
      this.openingReassertTimer = null;
      this.openingReassertDone = true;
      if (this.host.destroyed || this.host.video.paused || !this.host.guard.awaitingFirstPicture) return;
      const now = this.host.video.currentTime;
      // Parti de lui-même : rien à faire. Ni sur un élément qui a de quoi avancer et ne saute plus
      // (`readyState` ≥ 3) : il démarre, et le relancer le refigerait — voir `OPENING_PLAYING_GRACE_MS`.
      if (!this.host.video.seeking && Math.abs(now - at) > 0.05) return;
      if (!this.host.video.seeking && this.host.video.readyState >= 3) return;
      if (this.decodeDistance(now) >= OPENING_EDGE_SECONDS || this.host.lead < 1) return;
      const target = now + FROZEN_STEP;
      trace(`ouverture : rien n'a bougé 100 ms après l'atterrissage à ${now.toFixed(2)} s — position redemandée`);
      this.host.guard.forgetPause();
      this.host.seekState.moved(target);
      this.host.guard.headPlaced(target);
      this.host.video.currentTime = target;
      // Le pas n'est pas de la lecture, et la poussée de 400 ms se mesure depuis lui.
      this.lastClockAt = target;
      this.frozenSince = Date.now();
    }, OPENING_REASSERT_MS);
  }

  /**
   * La poussée de l'ouverture, pile au bout du délai de grâce qui suit `playing` (26/10/2026).
   *
   * Elle attendait le passage suivant du chien de garde, toutes les 250 ms : sur iPhone, les départs
   * du début figés (69 % en Dolby Vision) étaient poussés 750 ms en médiane après `playing`, au lieu
   * des 600 voulus, puis la première image venait encore ~500 ms plus tard (journal relu le
   * 26/10/2026 : 43 départs figés). Le seuil ne change pas — un départ sain montre son image 250 ms
   * après `playing` (450 ms pour neuf sur dix), et une poussée sur un élément qui démarre le refige,
   * d'où `OPENING_PLAYING_GRACE_MS` —, seul le retard du chien de garde disparaît. Une seule fois, à
   * l'ouverture, au bord du média, avant toute autre poussée ; le chien de garde reste le filet.
   */
  armOpeningGracePush(): void {
    if (this.openingGraceTimer !== null) clearTimeout(this.openingGraceTimer);
    this.openingGraceTimer = null;
    if (this.host.destroyed || !this.host.guard.awaitingFirstPicture || this.frozenNudges > 0) return;
    const at = this.host.video.currentTime;
    if (this.decodeDistance(at) >= OPENING_EDGE_SECONDS) return;
    this.openingGraceTimer = setTimeout(() => {
      this.openingGraceTimer = null;
      if (this.host.destroyed || this.host.video.paused || !this.host.guard.awaitingFirstPicture || this.frozenNudges > 0) return;
      const now = this.host.video.currentTime;
      // Parti : rien à faire.
      if (Math.abs(now - at) > 0.05) return;
      if (this.host.lead < 1) return;
      this.frozenSince = Date.now();
      this.nudge(now);
    }, OPENING_PLAYING_GRACE_MS);
  }

  /**
   * Combien de temps laisser un saut en cours finir de décoder : ce qu'il a réellement à décoder.
   *
   * Le média sous la tête commence à l'image clé d'où le décodage repart ; la distance jusqu'à la
   * tête est ce que le décodeur doit traverser avant de montrer quoi que ce soit. `FROZEN_SEEKING_MS`
   * a été fixé pour le pire cas (neuf secondes de 4K dans 1917) et s'appliquait à tous : un saut
   * dans une zone relue depuis une image clé à 2,8 s restait figé six secondes sous Safari avant
   * d'être poussé — deux fois dans la même séance sur un Mac, une fois sur un iPhone (journal du
   * 24/09/2026), là où la poussée le débloquait aussitôt. Une demi-seconde par seconde à décoder,
   * au-dessus du délai ordinaire, plafonnée à l'ancien délai : 1917 retrouve exactement ses six
   * secondes. Une plage qui commence loin derrière (un saut dans un long tampon continu) garde le
   * plafond — la vraie image clé est inconnue, et on reste alors sur la prudence d'avant.
   */
  private seekingPatienceMs(now: number): number {
    const ranges = this.host.playable;
    const i = rangeAround(ranges, now, 0);
    if (i >= 0) {
      const toDecode = now - ranges.start(i);
      return Math.min(FROZEN_SEEKING_MS, FROZEN_CLOCK_MS + SEEKING_PATIENCE_PER_SECOND_MS * toDecode);
    }
    return FROZEN_SEEKING_MS;
  }

  /**
   * The other kind of stall: playing, media under the playhead, and a clock that does not move.
   *
   * Everything above watches for a playhead standing on nothing, because that was every stall
   * there had been. This one is the opposite shape and nothing could see it: an episode opened
   * from the beginning reported itself as playing, with the playhead on the media and twenty
   * seconds buffered ahead of it, and stayed at 0:00. The element was waiting on a seek to the
   * exact first instant of the buffered range that never completed — so from here it looked
   * perfectly healthy, which is why it went unnoticed until it was reported from a phone.
   *
   * Answered the same way as the other, and just as bluntly: ask for the position again, a
   * fraction of a second further in, which is what completes a seek that never resolved.
   */
  watchForFrozenClock(now: number): void {
    const moved = Math.abs(now - this.lastClockAt) > 0.05;
    if (moved || this.frozenSince === null) {
      this.lastClockAt = now;
      this.frozenSince = moved || this.frozenSince === null ? Date.now() : this.frozenSince;
      if (moved) this.frozenNudges = 0;
      return;
    }
    const ordinary = this.host.video.seeking ? this.seekingPatienceMs(now) : FROZEN_CLOCK_MS;
    // Seulement une tête posée au bord du média, le cas mesuré : une reprise posée loin derrière son
    // image clé décode vraiment, et la pousser relancerait ce décodage (22/09/2026, « une seconde de
    // lecture pour deux de chargement »).
    const patience =
      this.host.guard.awaitingFirstPicture && this.frozenNudges === 0 && this.decodeDistance(now) < OPENING_EDGE_SECONDS
        ? FROZEN_OPENING_MS
        : ordinary;
    if (Date.now() - this.frozenSince < patience) return;
    // Un élément tout juste reparti produit encore sa première image : la poussée de l'ouverture
    // l'attend — voir `OPENING_PLAYING_GRACE_MS`.
    if (patience === FROZEN_OPENING_MS && Date.now() - this.lastPlayingAt < OPENING_PLAYING_GRACE_MS) return;
    // Only when there is plainly something to play: a clock that is not moving because the
    // buffer ran dry is an ordinary wait, and the fill loop is already on it.
    if (this.host.lead < 1) return;
    this.frozenSince = Date.now();
    if (this.frozenNudges >= MAX_FROZEN_NUDGES) {
      // Three pushes did not free it. This used to be the end of it — `return`, for as long as
      // the clock stayed put, which is to say for ever. Now it is the start of the recovery
      // ladder: the position asked for again the heavy way, buffers cleared and read afresh,
      // then the next keyframe, then a rebuild. Paced by `frozenSince`, once per 1.5 s at most.
      trace(`horloge figée à ${now.toFixed(2)} s malgré ${this.frozenNudges} poussées — reprise`);
      if (!this.host.recover(now + FROZEN_STEP)) this.host.handOver(now);
      // Même raison que pour la poussée ci-dessous : la reprise pose l'horloge 0,08 s plus loin,
      // et ce pas-là passait pour de la lecture. Les poussées repartaient à zéro après chaque
      // reprise — trois poussées, une reprise, trois poussées… — et une image figée mettait quatre
      // minutes à gravir l'échelle jusqu'au lecteur serveur au lieu d'une et demie (relu le
      // 24/09/2026, mesuré : 62 s → 21 s hors saut, 242 s → 96 s pendant un saut).
      this.lastClockAt = now + FROZEN_STEP;
      return;
    }

    this.nudge(now);
  }

  /** Redemander la position un pas plus loin — la poussée, du chien de garde ou de l'ouverture. */
  private nudge(now: number): void {
    this.frozenNudges += 1;
    this.frozenNudgesTotal += 1;
    trace(`horloge figée à ${now.toFixed(2)} s avec ${this.host.lead.toFixed(1)} s en avance — on redemande la position`);
    this.host.guard.forgetPause();
    this.host.seekState.moved(now + FROZEN_STEP);
    this.host.guard.headPlaced(now + FROZEN_STEP);
    this.host.video.currentTime = now + FROZEN_STEP;
    // Le mouvement se mesure depuis là où la poussée a mis l'horloge. Mesuré depuis `now`, les
    // 0,08 s de la poussée passaient pour de la lecture et remettaient le compteur à zéro : douze
    // poussées sur 1917, jamais une reprise.
    this.lastClockAt = now + FROZEN_STEP;
  }
}

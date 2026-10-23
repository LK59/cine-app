// L'échelle des reprises de `MseSource` : la même position redemandée trois fois au plus, puis
// l'image clé suivante, puis rien — l'appelant passe alors la main à l'hôte (`handOver`). Sorti de
// mseSource.ts tel quel ; `MseSource.recover` y délègue, et reste ce que tout le monde appelle.

import { trace } from "./trace";
import type { Remuxer } from "./remuxer";
import { MAX_RECOVERY_ATTEMPTS, MAX_UNPLAYED_ATTEMPTS, NEXT_KEYFRAME_MARGIN, RECOVERY_WINDOW_MS } from "./mseTuning";

/** Ce que l'échelle demande à la source : sauter, et de quoi trouver l'image clé suivante. */
export interface LadderHost {
  seek(playerSeconds: number, because: string): Promise<void>;
  readonly remuxer: Remuxer;
  toFileClock(playerSeconds: number): number;
  readonly playerEnd: number;
  readonly delaySeconds: number;
}

export class RecoveryLadder {
  constructor(private readonly host: LadderHost) {}

  recoveries = 0;
  private recoveryTarget = -1;
  recoveryStreak = 0;
  private lastRecoveryAt = 0;
  /**
   * Which rung of the recovery ladder has been climbed since the clock last really played: 0 none,
   * 1 the keyframe step, 2 handed to the host for a rebuild. See `escalate`.
   */
  escalation = 0;
  escalations = 0;
  /** Recoveries since the clock last really played — see `MAX_UNPLAYED_ATTEMPTS`. */
  unplayedAttempts = 0;
  /** Seconds the clock has genuinely run since the last recovery. */
  playedSinceTrouble = 0;

  /**
   * Seeks to where the viewer is, unless that has already been tried and did not help.
   *
   * Both recovery routes converge here so they share one limit. Without it, a target the file
   * genuinely cannot serve — an index pointing somewhere the media is not — turns a recovery
   * into a loop that seeks, fails to arrive, and seeks again as fast as it can.
   */
  recover(target: number): boolean {
    // The count only means anything while the attempts are rapid. The same position failing
    // again a minute later is a fresh problem, not a spin — and treating it as one used to latch
    // the guard shut, so the position stayed unreachable until the viewer seeked elsewhere.
    //
    // Measured from the last attempt that *went ahead*, never from the last call. It was
    // refreshed on every call, abandoned ones included, and the watchdog calls every 250 ms: the
    // window never ran out, and after the third attempt every later call gave up — the same latch
    // this was written to remove, reached by another road (22/09/2026, a clock held at 166 s for
    // nineteen seconds with nothing trying anything).
    if (Date.now() - this.lastRecoveryAt > RECOVERY_WINDOW_MS) this.recoveryStreak = 0;

    const sameSpot = Math.abs(target - this.recoveryTarget) < 1;
    if ((sameSpot && this.recoveryStreak >= MAX_RECOVERY_ATTEMPTS) || this.unplayedAttempts >= MAX_UNPLAYED_ATTEMPTS) {
      return this.escalate(target);
    }
    if (sameSpot) this.recoveryStreak += 1;
    else {
      this.recoveryTarget = target;
      this.recoveryStreak = 1;
    }
    this.attempt(target, `reprise ${this.recoveryStreak}`);
    return true;
  }

  /** One recovery seek, counted everywhere it has to be. */
  private attempt(target: number, because: string): void {
    this.lastRecoveryAt = Date.now();
    this.recoveries += 1;
    this.unplayedAttempts += 1;
    this.playedSinceTrouble = 0;
    void this.host.seek(target, because);
  }

  /**
   * Asking for the same spot again has not helped: the next rung, or false when none is left.
   *
   * Giving up used to be the last word — traced, and then nothing, for as long as the viewer
   * waited. The rungs, each tried once until the clock has really played again:
   *
   * 1. **The next keyframe past the head.** The same position re-read is the same group of
   *    pictures decoded the same way; an open-GOP keyframe ten seconds on is a group nothing has
   *    touched. A viewer loses a few seconds rather than the film.
   * 2. **Nothing more here** — false, and the caller hands over (`handOver`) so the host rebuilds
   *    the whole pipeline at the head, within its own budget.
   *
   * Still traced rather than shown, as the abandon always was: the remuxer's own index back-up
   * regularly lands a position a moment after the source has given up on it, and a banner
   * announced a failure to a viewer whose film was about to carry on.
   */
  private escalate(target: number): boolean {
    if (this.escalation >= 1) return false;
    this.escalation = 1;
    this.escalations += 1;
    trace(`reprise abandonnée après ${this.recoveryStreak} tentatives vers ${target.toFixed(1)} s`);
    const next = this.nextKeyframeAfter(target);
    if (next === null) return false;
    trace(`reprise : image clé suivante, ${next.toFixed(1)} s`);
    // Counted as the first attempt at the new spot, so it too gets three before the last rung.
    this.recoveryTarget = next;
    this.recoveryStreak = 1;
    this.attempt(next, "reprise : image clé suivante");
    return true;
  }

  /**
   * The next indexed keyframe on the player's clock, far enough past `target` to be a different
   * group, or null. Never throws: this runs on the path that is already failing.
   */
  private nextKeyframeAfter(target: number): number | null {
    try {
      if (!this.host.remuxer.seekable) return null;
      // Half a second on, so a head standing right on a keyframe does not pick that same one.
      const fileSeconds = this.host.remuxer.keyframeAfter(this.host.toFileClock(target) + 0.5);
      if (fileSeconds === null) return null;
      const end = this.host.playerEnd;
      const next = fileSeconds + this.host.delaySeconds + NEXT_KEYFRAME_MARGIN;
      return next < end - 1 ? next : null;
    } catch {
      return null;
    }
  }
}

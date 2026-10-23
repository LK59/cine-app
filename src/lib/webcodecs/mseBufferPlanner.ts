// Jusqu'où `MseSource` remplit : la cible de ce fichier (abaissée sur un refus de quota), le budget
// en octets de ce navigateur mesuré sur le débit réellement envoyé (`bufferBudget.ts`), et la place
// que le son a vraiment. Sorti de mseSource.ts tel quel ; la source lui prête la position de travail
// et ses deux files.

import { trace } from "./trace";
import type { BufferQueue } from "./bufferQueue";
import { AUDIO_LANE_SHARE, ByteRate, currentSourceBufferQuota, laneBudget, tightest, type BufferBudget } from "./bufferBudget";
import { KEEP_BEHIND_SECONDS, MIN_BUFFER_SECONDS, TARGET_BUFFER_SECONDS } from "./mseTuning";

/** Ce que le plan lit de la source, à chaque question : où elle travaille (`anchor`), ses deux files. */
export interface PlannerHost {
  anchor(): number;
  videoOps(): BufferQueue | null;
  audioOps(): BufferQueue | null;
}

export class BufferPlanner {
  constructor(private readonly host: PlannerHost) {}

  /** How far ahead to fill. Lowered, for this file only, if the browser says it cannot hold it. */
  targetBuffer = TARGET_BUFFER_SECONDS;
  /**
   * Le plafond de ce navigateur en octets, et le débit réellement envoyé à chaque tampon — voir
   * `bufferBudget.ts`. Null pour un moteur qu'on ne connaît pas : rien n'y change.
   */
  private readonly quota = currentSourceBufferQuota();
  readonly videoRate = new ByteRate();
  readonly audioRate = new ByteRate();
  /** Le dernier budget écrit dans la trace, pour ne l'écrire que lorsqu'il change vraiment. */
  private tracedBudget: BufferBudget | null = null;

  /**
   * Le budget en octets de ce navigateur pour ce fichier, en secondes — le plus serré des deux
   * tampons. Null tant que le débit n'est pas mesuré, et partout ailleurs que sur WebKit.
   */
  get budget(): BufferBudget | null {
    if (!this.quota) return null;
    const budget = tightest(
      this.host.videoOps() ? laneBudget(this.quota.video, this.videoRate.bytesPerSecond, TARGET_BUFFER_SECONDS, KEEP_BEHIND_SECONDS, MIN_BUFFER_SECONDS) : null,
      this.audioBudget
    );
    // Écrit à la première mesure, puis quand il bouge d'au moins trois secondes : de quoi lire au
    // journal ce que le lecteur visait, sans une ligne par segment.
    const before = this.tracedBudget;
    if (budget && (!before || Math.abs(before.aheadSeconds - budget.aheadSeconds) >= 3 || Math.abs(before.behindSeconds - budget.behindSeconds) >= 3)) {
      this.tracedBudget = budget;
      const mo = (n: number | null) => (n === null ? "?" : (n / 1e6).toFixed(1));
      trace(
        `budget ${this.quota.engine} : ${Math.round(this.quota.video / 1e6)} Mo d'image, ${Math.round(this.quota.audio / 1e6)} Mo de son, image ${mo(this.videoRate.bytesPerSecond)} Mo/s, son ${mo(this.audioRate.bytesPerSecond)} Mo/s — ` +
          `${budget.aheadSeconds.toFixed(1)} s devant, ${budget.behindSeconds.toFixed(1)} s derrière`
      );
    }
    return budget;
  }

  /** Le budget du son seul, sur la part de son plafond qu'on se donne (`AUDIO_LANE_SHARE`). */
  private get audioBudget(): BufferBudget | null {
    if (!this.quota || !this.host.audioOps()) return null;
    return laneBudget(this.quota.audio * AUDIO_LANE_SHARE, this.audioRate.bytesPerSecond, TARGET_BUFFER_SECONDS, KEEP_BEHIND_SECONDS, MIN_BUFFER_SECONDS);
  }

  /**
   * L'avance que le tampon du son peut encore prendre sans passer son plafond, compte tenu de ce
   * qu'il tient *réellement* derrière la tête (et ailleurs) — null sans budget.
   *
   * Le budget suppose l'arrière déjà ramené au sien. Ce n'est pas le cas juste après un saut en
   * avant : ce qui était devant passe derrière d'un coup, le retrait attend que le saut soit fini
   * (`trimBehind`), et l'avance, elle, se refaisait aussitôt en entier. iPad, *Forrest Gump*,
   * 30/09/2026 : +10 s, 60 s de son tenus pour un plafond qui en tenait à peine autant, et WebKit
   * a retiré lui-même le son de 1559,87 à 1590,37 s, tête à 1563,7 s — l'élément est resté
   * `seeking` cinq secondes sur une image présente. Deux fois dans le film. L'image n'a pas cette
   * borne : son arrière ne peut pas descendre sous l'image clé de la tête (`behindLimit`), et un
   * long groupe la tiendrait au plancher de huit secondes pendant tout le groupe.
   */
  private audioRoom(): number | null {
    const budget = this.audioBudget;
    const ranges = this.host.audioOps()?.buffer.buffered;
    if (!budget || !ranges) return null;
    const now = this.host.anchor();
    let held = 0;
    let ahead = 0;
    for (let i = 0; i < ranges.length; i++) {
      held += ranges.end(i) - ranges.start(i);
      if (ranges.start(i) <= now + 0.1 && now < ranges.end(i)) ahead = ranges.end(i) - now;
    }
    return budget.totalSeconds - (held - ahead);
  }

  /**
   * L'avance visée : la plus petite de la cible de ce fichier, du budget en octets, et de la place
   * que le son a réellement (`audioRoom`) — jamais sous le plancher de huit secondes, sans quoi un
   * arrière pas encore retiré arrêterait la lecture elle-même.
   */
  get aheadTarget(): number {
    const room = this.audioRoom();
    return Math.min(this.targetBuffer, this.budget?.aheadSeconds ?? Infinity, room === null ? Infinity : Math.max(MIN_BUFFER_SECONDS, room));
  }
}

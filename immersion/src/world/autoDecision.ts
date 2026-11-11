/**
 * La décision d'« Auto », sans navigateur ni three : ce que `AutoQuality` fait d'une fenêtre de 2,5 s (dix tranches
 * de 250 ms). Pure, pour être éprouvée avec des cadences fabriquées (`tests/e2e/16-auto.spec.ts`) — une machine de
 * test ne sait pas produire à la demande une cadence de 60 images/s régulière.
 *
 * Les règles (voir `AutoQuality.tsx` pour le pourquoi) :
 * - descendre quand plus des trois quarts des tranches sont sous le seuil bas, ou à trois images de plus de 50 ms ;
 * - remonter quand plus des trois quarts dépassent le seuil haut, sans aucune image de plus de 33 ms, et que rien ne
 *   l'interdit encore : 10 s après une descente, et après un aller-retour (une montée suivie d'une descente en moins
 *   de 15 s) 60 s, doublées à chaque récidive jusqu'à 5 min. Jamais de gel définitif.
 */
export const WINDOW = 10;
export const SETTLE_MS = 3000;
const UP_AFTER_DOWN_MS = 10_000;
const FLIP_MS = 15_000;
const HOLD_FIRST_MS = 60_000;
const HOLD_MAX_MS = 300_000;

export interface AutoMemory {
  /** Pas de remontée avant cet instant. */
  upBlockedUntil: number;
  /** La dernière montée (pour reconnaître un aller-retour). */
  lastUpAt: number;
  /** L'interdiction à poser au prochain aller-retour. */
  hold: number;
}

export const freshMemory = (): AutoMemory => ({ upBlockedUntil: 0, lastUpAt: -Infinity, hold: HOLD_FIRST_MS });

export interface AutoWindow {
  /** La cadence de chaque tranche de 250 ms. */
  samples: number[];
  /** Les images de plus de 33 et de 50 ms dans la fenêtre. */
  over33: number;
  over50: number;
  /** La cadence d'affichage estimée (la meilleure tranche vue depuis le début). */
  refresh: number;
}

export type AutoStep = { to: number; why: "fps" | "acoups" | "marge" } | null;

/** Que faire de cette fenêtre, au niveau `level` (0 = Ultra, `last` = le plus bas), à l'instant `now` ? */
export function decide(window: AutoWindow, level: number, last: number, now: number, memory: AutoMemory): AutoStep {
  const [lower, upper] = window.refresh > 90 ? [80, 110] : [50, 58];
  const low = window.samples.filter((v) => v < lower).length;
  const high = window.samples.filter((v) => v >= upper).length;
  const slow = low > window.samples.length * 0.75;
  if ((slow || window.over50 >= 3) && level < last) {
    // Monté il y a peu, et déjà trop lent : un aller-retour — on ne remonte plus avant un moment, de plus en plus long.
    if (now - memory.lastUpAt < FLIP_MS) {
      memory.upBlockedUntil = now + memory.hold;
      memory.hold = Math.min(HOLD_MAX_MS, memory.hold * 2);
    } else memory.upBlockedUntil = Math.max(memory.upBlockedUntil, now + UP_AFTER_DOWN_MS);
    return { to: level + 1, why: slow ? "fps" : "acoups" };
  }
  if (high > window.samples.length * 0.75 && window.over33 === 0 && level > 0 && now >= memory.upBlockedUntil) {
    memory.lastUpAt = now;
    return { to: level - 1, why: "marge" };
  }
  return null;
}

// La durée d'un saut, du geste à son arrivée, sans le temps passé en arrière-plan entre les deux —
// pour les deux lecteurs (`seekWaitMs` au bilan). Écrite pour le natif le 24/09/2026 (`seekDuration`,
// hostSeek.ts : un Mac mis en veille pendant un saut comptait 286 s d'attente) ; le serveur comptait
// l'absence entière jusqu'au 23/10/2026 (audit F1-3, DECISIONS.md §116).
import { seekDuration, type SeekTiming } from "@/lib/hostSeek";
import type { SessionTally } from "@/lib/playerSessionTally";

/** Le début d'un saut : son instant et le temps passé en arrière-plan jusque-là (`tally.hiddenMsSoFar`). */
export type SeekStart = Pick<SeekTiming, "startedAt" | "hiddenAtStart">;

/** Un saut commence maintenant. */
export function seekStart(tally: SessionTally, now = Date.now()): SeekStart {
  return { startedAt: now, hiddenAtStart: tally.hiddenMsSoFar(now) };
}

/** La durée d'un saut, sans le temps passé en arrière-plan — voir `seekDuration` (hostSeek.ts). */
export function seekElapsed(tally: SessionTally, timing: SeekStart): number {
  const now = Date.now();
  return seekDuration(timing, now, tally.hiddenMsSoFar(now));
}

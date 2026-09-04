// A timestamped record of what the player did while opening a file.
//
// The technical panel only exists once there is a player to attach it to. Both failures worth
// debugging happen before that: one ends on the error screen, the other never ends at all. Neither
// leaves anything behind on a phone, where there is no console to read — so every step worth
// naming is recorded here as it happens, and the host shows the record instead of the panel.

/**
 * How much of a run is kept.
 *
 * Split in two on purpose. The opening is the most valuable part of any record — which path was
 * chosen, what the browser said yes to, how the first segments went — and it is also the part a
 * fault two hours later has nothing to do with. So the beginning is held for good, and the rest
 * slides: the last few hundred steps before whatever just happened. Between them sits one line
 * saying how much was dropped, so nobody reads a record with a hole in it and thinks it whole.
 *
 * Truncating instead — which is what this did — meant a film that ran long simply stopped
 * recording, and the fault worth reading about was the one guaranteed to be missing.
 */
const KEPT_FROM_THE_START = 120;
const KEPT_AT_THE_END = 280;

export interface TraceStep {
  /** Milliseconds since the run started. */
  at: number;
  step: string;
}

let startedAt = 0;
let steps: TraceStep[] = [];
let keepAcrossNextReset = false;
/** How many steps the middle of the record no longer holds. Reported rather than hidden. */
let dropped = 0;

/**
 * Carries the record through the next fresh start.
 *
 * The player rebuilds itself when the platform takes the source away, and rebuilding runs the
 * probe again, which starts a new record. That erased the only account of what went wrong — the
 * fault and its aftermath ended up in different records, and the report showed the innocent one.
 */
export function traceKeepAcrossReset(): void {
  keepAcrossNextReset = true;
}

/** Starts a fresh record. Called once per attempt to open a file. */
export function traceReset(): void {
  if (keepAcrossNextReset) {
    keepAcrossNextReset = false;
    return;
  }
  startedAt = Date.now();
  steps = [];
  dropped = 0;
}

/**
 * Records one step.
 *
 * Deliberately impossible to fail: this is instrumentation on the path that is already going
 * wrong, and instrumentation that can throw would replace the fault being investigated with
 * itself.
 */
export function trace(step: string): void {
  try {
    if (startedAt === 0) startedAt = Date.now();
    steps.push({ at: Date.now() - startedAt, step });
    // Trimmed from the middle, and only when there is enough there to be worth trimming, so a
    // long run costs one splice every few hundred steps rather than one per step.
    if (steps.length > KEPT_FROM_THE_START + KEPT_AT_THE_END + 64) {
      dropped += steps.length - (KEPT_FROM_THE_START + KEPT_AT_THE_END);
      steps = [...steps.slice(0, KEPT_FROM_THE_START), ...steps.slice(steps.length - KEPT_AT_THE_END)];
    }
  } catch {
    /* never */
  }
}

export function traceSteps(): TraceStep[] {
  return steps;
}

/** The record as text, one step per line, for the report the viewer copies. */
export function traceText(): string {
  if (steps.length === 0) return "(aucune étape enregistrée)";
  const line = (s: TraceStep) => `${String(s.at).padStart(6)} ms  ${s.step}`;
  if (dropped === 0) return steps.map(line).join("\n");
  // Said out loud, and in the right place: a record with a silent hole in it reads as a record
  // of a run that did nothing for an hour.
  return [
    ...steps.slice(0, KEPT_FROM_THE_START).map(line),
    `         ⋯  ${dropped} étapes plus anciennes retirées`,
    ...steps.slice(KEPT_FROM_THE_START).map(line),
  ].join("\n");
}

/** Milliseconds since the record was started, for a run that has not finished. */
export function traceElapsed(): number {
  return startedAt === 0 ? 0 : Date.now() - startedAt;
}

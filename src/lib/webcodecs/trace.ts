// A timestamped record of what the player did while opening a file.
//
// The technical panel only exists once there is a player to attach it to. Both failures worth
// debugging happen before that: one ends on the error screen, the other never ends at all. Neither
// leaves anything behind on a phone, where there is no console to read — so every step worth
// naming is recorded here as it happens, and the host shows the record instead of the panel.

/** A run of the pipeline is a few dozen steps. The cap is only there so a loop cannot grow it. */
const MAX_STEPS = 300;

export interface TraceStep {
  /** Milliseconds since the run started. */
  at: number;
  step: string;
}

let startedAt = 0;
let steps: TraceStep[] = [];

/** Starts a fresh record. Called once per attempt to open a file. */
export function traceReset(): void {
  startedAt = Date.now();
  steps = [];
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
    if (steps.length >= MAX_STEPS) return;
    if (startedAt === 0) startedAt = Date.now();
    steps.push({ at: Date.now() - startedAt, step });
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
  return steps.map((s) => `${String(s.at).padStart(6)} ms  ${s.step}`).join("\n");
}

/** Milliseconds since the record was started, for a run that has not finished. */
export function traceElapsed(): number {
  return startedAt === 0 ? 0 : Date.now() - startedAt;
}

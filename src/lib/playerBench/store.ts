import type { BenchConfig, BenchQuestion, ItemResult } from "./runner";

/**
 * L'état d'un banc d'essai en cours, hors de React.
 *
 * Le banc se lance depuis le panneau Compte, qui se ferme ou passe sous le lecteur à la seconde où
 * le premier film s'ouvre : l'état ne peut donc pas vivre dans le panneau. Il vit ici, et
 * `BenchRunner` — monté une fois, sous `PlaybackProvider` — l'exécute et l'affiche.
 */

export interface BenchState {
  phase: "idle" | "running" | "done";
  config: BenchConfig | null;
  itemIndex: number;
  step: string;
  question: BenchQuestion | null;
  results: ItemResult[];
  startedAt: number;
  finishedAt: number;
  cancelled: boolean;
}

const IDLE: BenchState = {
  phase: "idle",
  config: null,
  itemIndex: 0,
  step: "",
  question: null,
  results: [],
  startedAt: 0,
  finishedAt: 0,
  cancelled: false,
};

let state: BenchState = IDLE;
const listeners = new Set<() => void>();
let answerQuestion: ((value: string) => void) | null = null;

function set(patch: Partial<BenchState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export const benchStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  get: (): BenchState => state,
  /** Pour le rendu serveur : jamais de banc. */
  idle: (): BenchState => IDLE,
};

export function startBench(config: BenchConfig): void {
  if (state.phase === "running") return;
  set({ ...IDLE, phase: "running", config, startedAt: Date.now() });
}

export function benchProgress(itemIndex: number, step: string): void {
  set({ itemIndex, step });
}

export function benchAddResult(result: ItemResult): void {
  set({ results: [...state.results, result] });
}

export function benchAsk(question: BenchQuestion): Promise<string> {
  return new Promise((resolve) => {
    answerQuestion = resolve;
    set({ question });
  });
}

export function benchAnswer(value: string): void {
  const resolve = answerQuestion;
  answerQuestion = null;
  set({ question: null });
  resolve?.(value);
}

export function cancelBench(): void {
  set({ cancelled: true });
  // Une question en attente retiendrait l'arrêt jusqu'à ce qu'on y réponde.
  if (answerQuestion) benchAnswer("skip");
}

export function finishBench(): void {
  set({ phase: "done", finishedAt: Date.now(), question: null, step: "" });
}

export function dismissBench(): void {
  set(IDLE);
}

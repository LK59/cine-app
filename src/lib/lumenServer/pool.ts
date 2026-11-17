// La file de Lumen serveur : combien de constructions à la fois, et combien de mémoire.
//
// cine-app vit dans 2 Gio (`mem_limit`), dont ~320 Mo occupés hors de toute lecture (2-serveur.md
// §2.4). Un segment 4K tient 20 à 45 Mo pendant sa construction, le double au pic — ce qui est lu et
// ce qui est produit coexistent —, et les `Buffer` vivent hors du tas V8 mais dans le cgroup. Sans
// borne, quatre spectateurs qui sautent dans un film 4K au même moment suffiraient à faire tuer le
// conteneur. Deux bornes, donc :
// - **un nombre de constructions simultanées** (3 par défaut : 3 à 6 lectures simultanées attendues,
//   et le disque, partagé avec X-Ray, sature avant le processeur) ;
// - **un budget de mémoire** : la somme des coûts estimés des constructions en cours (deux fois le
//   poids du segment) reste sous 256 Mo. Une construction plus lourde que tout le budget passe seule.
// La file attend dans l'ordre d'arrivée (pas de dépassement : un gros segment n'attend pas pour
// toujours derrière des petits) et refuse au-delà de `maxQueued` (`LumenError("occupe")`) : mieux vaut
// une erreur que l'étape 3 traduit en « réessaie » qu'une file qui grossit sans fin.
//
// Deux exécutants derrière la même interface : `workerExecutor` (des `worker_threads`, le module de
// `worker.ts` empaqueté) et `inlineExecutor` (le fil principal, pour les tests et en repli).

import { Worker } from "node:worker_threads";
import { LumenError } from "./format";
import { requestTransferablesOf, runLumenJob, type LumenJob, type LumenJobResult } from "./jobs";
import type { WorkerRequest, WorkerResponse } from "./worker";

export interface LumenExecutor {
  readonly kind: "inline" | "workers";
  run(job: LumenJob): Promise<LumenJobResult>;
  close(): Promise<void>;
}

/** Le travail fait sur le fil appelant. */
export function inlineExecutor(handler: (job: LumenJob) => Promise<LumenJobResult> = runLumenJob): LumenExecutor {
  return { kind: "inline", run: handler, close: async () => {} };
}

/**
 * `threads` fils, chacun un travail à la fois. `script` : le module de `worker.ts` empaqueté
 * (`tools/lumen-worker/build.mjs`). Un fil qui meurt rejette son travail en cours et est remplacé.
 */
export function workerExecutor(script: string | URL, threads: number): LumenExecutor {
  interface Slot {
    worker: Worker;
    busy: { id: number; resolve: (r: LumenJobResult) => void; reject: (e: Error) => void } | null;
  }
  let nextId = 1;
  let closed = false;
  const waiting: { job: LumenJob; resolve: (r: LumenJobResult) => void; reject: (e: Error) => void }[] = [];
  const slots: Slot[] = [];

  const spawn = (): Slot => {
    const slot: Slot = { worker: new Worker(script, { workerData: { lumenWorker: true } }), busy: null };
    slot.worker.on("message", (response: WorkerResponse) => {
      const busy = slot.busy;
      if (!busy || busy.id !== response.id) return;
      slot.busy = null;
      if (response.ok) busy.resolve(response.result);
      else busy.reject(response.error.code ? new LumenError(response.error.code as LumenError["code"], response.error.message) : new Error(response.error.message));
      dispatch();
    });
    const lost = (error: Error) => {
      const busy = slot.busy;
      slot.busy = null;
      busy?.reject(error);
      const at = slots.indexOf(slot);
      if (at >= 0 && !closed) {
        slots[at] = spawn();
        dispatch();
      }
    };
    slot.worker.on("error", lost);
    slot.worker.on("exit", (code) => {
      if (!closed) lost(new Error(`Fil de calcul Lumen arrêté (code ${code}).`));
    });
    return slot;
  };
  for (let i = 0; i < Math.max(1, threads); i++) slots.push(spawn());

  const dispatch = () => {
    for (const slot of slots) {
      if (slot.busy || waiting.length === 0) continue;
      const next = waiting.shift()!;
      const id = nextId++;
      slot.busy = { id, resolve: next.resolve, reject: next.reject };
      const request: WorkerRequest = { id, job: next.job };
      slot.worker.postMessage(request, requestTransferablesOf(next.job));
    }
  };

  return {
    kind: "workers",
    run: (job) =>
      new Promise((resolve, reject) => {
        if (closed) return reject(new Error("Exécutant fermé."));
        waiting.push({ job, resolve, reject });
        dispatch();
      }),
    close: async () => {
      closed = true;
      for (const w of waiting.splice(0)) w.reject(new Error("Exécutant fermé."));
      await Promise.all(slots.map((slot) => slot.worker.terminate()));
    },
  };
}

export interface QueueOptions {
  concurrency?: number;
  memoryBudget?: number;
  maxQueued?: number;
}

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_MEMORY_BUDGET = 256 * 1024 * 1024;
export const DEFAULT_MAX_QUEUED = 24;

/** Une file bornée en nombre et en mémoire estimée. */
export class LumenQueue {
  private running = 0;
  private usedBytes = 0;
  private readonly waiting: { cost: number; start: () => void }[] = [];
  readonly concurrency: number;
  readonly memoryBudget: number;
  readonly maxQueued: number;
  /** Le plus de mémoire estimée tenue à la fois — relevé pour le banc et le journal. */
  peakBytes = 0;

  constructor(options: QueueOptions = {}) {
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.memoryBudget = options.memoryBudget ?? DEFAULT_MEMORY_BUDGET;
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  get stats(): { running: number; queued: number; usedBytes: number } {
    return { running: this.running, queued: this.waiting.length, usedBytes: this.usedBytes };
  }

  /** Lance `work` dès que la file le permet ; `cost` : la mémoire estimée qu'il tiendra. */
  run<T>(cost: number, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running += 1;
        this.usedBytes += cost;
        this.peakBytes = Math.max(this.peakBytes, this.usedBytes);
        work().then(resolve, reject).finally(() => {
          this.running -= 1;
          this.usedBytes -= cost;
          this.pump();
        });
      };
      if (this.waiting.length === 0 && this.fits(cost)) return start();
      if (this.waiting.length >= this.maxQueued) return reject(new LumenError("occupe", "File de Lumen serveur pleine."));
      this.waiting.push({ cost, start });
    });
  }

  private fits(cost: number): boolean {
    if (this.running >= this.concurrency) return false;
    // Plus lourd que tout le budget : seul, mais il passe.
    return this.running === 0 || this.usedBytes + cost <= this.memoryBudget;
  }

  private pump(): void {
    // Dans l'ordre d'arrivée : la tête attend tant qu'elle ne tient pas, les suivants aussi.
    while (this.waiting.length > 0 && this.fits(this.waiting[0].cost)) this.waiting.shift()!.start();
  }
}

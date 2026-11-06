// Un `Worker` du navigateur, dans Node : un fil `worker_threads` qui exécute le même fichier que le
// navigateur (truehdWorker.mjs, tel quel), avec ce qu'un worker dédié y trouve — `self`,
// `postMessage` avec transferts, `onmessage`, et `WorkerGlobalScope`, que le fichier et le module
// d'emscripten testent pour savoir où ils sont. Une adresse `blob:` (le module en ligne que la page
// crée pour lancer le worker) est relue et exécutée telle quelle, en module. Sert à la suite (webcodecs-truehd-worker.test.ts) et
// au banc ffmpeg-wasm-regress-bench.spec.ts (FFW_WORKER=1) : prouver que le chemin du worker rend
// les mêmes flottants que le fil principal.
import { Worker as ThreadWorker } from "node:worker_threads";
import { resolveObjectURL } from "node:buffer";

const BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
globalThis.self = globalThis;
globalThis.WorkerGlobalScope = class WorkerGlobalScope {
  static [Symbol.hasInstance](value) { return value === globalThis; }
};
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer ?? []);
// Les messages arrivés avant la fin du chargement du fichier attendent leur tour, dans l'ordre.
let early = [];
parentPort.on("message", (data) => (early ? early.push(data) : globalThis.onmessage?.({ data })));
import(workerData.url).then(() => {
  const queued = early;
  early = null;
  for (const data of queued) globalThis.onmessage?.({ data });
}, (error) => { throw error; });
`;

export class NodeWebWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private thread: ThreadWorker | null = null;
  /** Ce qui a été posté avant que le fil existe (le temps de relire une adresse `blob:`). */
  private queued: Array<[unknown, Transferable[]]> = [];
  private terminated = false;
  /** Combien de ces workers ont été créés, et combien vivent encore — pour les tests de fuite. */
  static created = 0;
  static alive = 0;

  constructor(url: URL | string) {
    NodeWebWorker.created++;
    const href = String(url);
    if (!href.startsWith("blob:")) this.start(href);
    else {
      const blob = resolveObjectURL(href);
      if (!blob) throw new Error(`adresse blob inconnue : ${href}`);
      void blob.text().then((code) => this.start(`data:text/javascript,${encodeURIComponent(code)}`));
    }
  }

  private start(href: string): void {
    if (this.terminated) return;
    NodeWebWorker.alive++;
    const thread = new ThreadWorker(BOOTSTRAP, { eval: true, workerData: { url: href } });
    this.thread = thread;
    thread.unref();
    thread.on("message", (data) => this.onmessage?.({ data }));
    thread.on("error", (error: Error) => this.onerror?.({ message: error.message, preventDefault() {} }));
    thread.on("messageerror", () => this.onmessageerror?.());
    thread.on("exit", () => NodeWebWorker.alive--);
    for (const [message, transfer] of this.queued.splice(0)) thread.postMessage(message, transfer as never);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.thread) this.thread.postMessage(message, transfer as never);
    else this.queued.push([message, transfer]);
  }

  terminate(): void {
    this.terminated = true;
    void this.thread?.terminate();
  }
}

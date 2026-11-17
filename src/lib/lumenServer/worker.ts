// Le point d'entrée d'un fil de calcul (`worker_threads`) de Lumen serveur.
//
// Construire un segment est synchrone par morceaux — 5 à 15 ms de calcul par seconde de 4K mesurés à
// l'étude, des dizaines de millisecondes pour un groupe de 40 Mo — et la boucle d'événements de
// cine-app sert aussi le catalogue, le proxy et les autres spectateurs : le calcul se fait ici.
//
// **Ce fichier ne se charge pas tel quel.** Il importe du TypeScript par des chemins sans extension
// et des alias (`@/…`) que Node ne résout pas seul, et Next (Turbopack) n'émet pas d'entrée pour un
// `worker_threads` côté serveur. Il est donc empaqueté à part, en un seul module ESM autonome, par
// `tools/lumen-worker/build.mjs` (rolldown, déjà installé avec vitest) — c'est ce que fait le banc,
// et ce que l'étape 3 fera dans le Dockerfile (README de docs/remux-serveur, « Étape 2 »).
// Sans lui, `inlineExecutor` fait le même travail sur le fil principal.

import { parentPort, workerData } from "node:worker_threads";
import { ownBuffer, runLumenJob, type LumenJob, type LumenJobResult } from "./jobs";
import { LumenError } from "./format";

export interface WorkerRequest {
  id: number;
  job: LumenJob;
}

export type WorkerResponse =
  | { id: number; ok: true; result: LumenJobResult }
  | { id: number; ok: false; error: { message: string; code?: string } };

/** Les tampons d'une réponse, transférés plutôt que copiés : un segment 4K pèse des dizaines de Mo. */
export function transferablesOf(result: LumenJobResult): ArrayBuffer[] {
  if (result.type === "dialogue") return result.segments.map(ownBuffer).filter((b): b is ArrayBuffer => b !== null);
  const bytes = result.type === "segment" ? result.result.bytes : result.type === "audio-feed" ? (result.feed?.bytes ?? null) : null;
  if (!bytes) return [];
  const buffer = bytes.buffer;
  return buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength ? [buffer] : [];
}

// Seulement dans un fil lancé par le pool (`workerData.lumenWorker`) : la suite de tests tourne elle-même
// dans des `worker_threads`, et importer ce module là ne doit pas écouter le canal de Vitest.
if (parentPort && (workerData as { lumenWorker?: boolean } | null)?.lumenWorker === true) {
  const port = parentPort;
  port.on("message", async (request: WorkerRequest) => {
    try {
      const result = await runLumenJob(request.job);
      const response: WorkerResponse = { id: request.id, ok: true, result };
      port.postMessage(response, transferablesOf(result));
    } catch (error) {
      const response: WorkerResponse = {
        id: request.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error), code: error instanceof LumenError ? error.code : undefined },
      };
      port.postMessage(response);
    }
  });
}

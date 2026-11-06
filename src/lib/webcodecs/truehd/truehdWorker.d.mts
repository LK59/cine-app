// Types de truehdWorker.mjs (servi tel quel au worker, donc écrit en JavaScript).
import type { TrueHdModule } from "./truehd-wasm.mjs";

export interface DecodedBatch {
  /** Flottants entrelacés, [image][canal], ordre WAVE — tous les blocs bout à bout. */
  pcm: Float32Array;
  /** Images rendues par chaque bloc, dans l'ordre : zéro avant la première synchronisation. */
  frames: Int32Array;
  channels: number;
  sampleRate: number;
  /** Blocs que le décodeur a refusés. */
  errors: number;
}

/** La mémoire d'entrée d'un décodeur dans le module, gardée d'un lot à l'autre. */
export interface DecodeScratch {
  input: number;
  inputSize: number;
}

export function decodeBlocks(m: TrueHdModule, decoder: number, scratch: DecodeScratch, blocks: Uint8Array[]): DecodedBatch;
export function closeDecoder(m: TrueHdModule, decoder: number, scratch: DecodeScratch): void;

/** Ce qu'un worker (ou son double dans Node) doit offrir pour être servi. */
export interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}
export function serveTrueHd(scope: WorkerScope): void;

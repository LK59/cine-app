// Le décodeur AAC natif de FFmpeg, compilé en WebAssembly (tools/aac-wasm), vu d'ici.
//
// Le jumeau de truehd/truehdCore.ts : rien de ce qui entoure le décodage, ni lecture du fichier, ni
// temps. Tourne tel quel dans le navigateur et dans Node, où le banc (aac-wasm-bench.spec.ts) le
// fait décoder « Elle s'appelle Ruby » et le compare canal par canal à ffmpeg.
import type { AacModule } from "./aac-wasm.mjs";
import type { DecodedBatch } from "../truehd/truehdCore";

export type { DecodedBatch };

/** Le module, instancié une fois et gardé ; une instanciation qui échoue n'est pas gardée. */
let loaded: Promise<AacModule> | null = null;

function instance(): Promise<AacModule> {
  if (!loaded) {
    loaded = import("./aac-wasm.mjs").then(({ default: createAac }) => createAac());
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

export class AacCore {
  private input = 0;
  private inputSize = 0;
  private closed = false;

  private constructor(
    private readonly wasm: AacModule,
    private readonly decoder: number
  ) {}

  /** `asc` : la configuration AAC de la piste (AudioSpecificConfig, PCE compris). */
  static async create(asc: Uint8Array): Promise<AacCore> {
    const wasm = await instance();
    const at = wasm._malloc(asc.length);
    wasm.HEAPU8.set(asc, at);
    const decoder = wasm._aac_open(at, asc.length);
    wasm._free(at);
    if (!decoder) throw new Error("le décodeur AAC n'a pas pu s'ouvrir");
    return new AacCore(wasm, decoder);
  }

  decode(blocks: Uint8Array[]): DecodedBatch {
    if (this.closed) throw new Error("décodeur AAC fermé");
    const m = this.wasm;
    const frames = new Int32Array(blocks.length);
    const parts: Float32Array[] = [];
    let channels = 0;
    let sampleRate = 0;
    let errors = 0;
    let total = 0;
    blocks.forEach((block, i) => {
      if (block.length > this.inputSize) {
        if (this.input) m._free(this.input);
        this.inputSize = Math.max(block.length, 16 * 1024);
        this.input = m._malloc(this.inputSize);
      }
      m.HEAPU8.set(block, this.input);
      const n = m._aac_decode(this.decoder, this.input, block.length);
      if (n < 0) throw new Error("mémoire épuisée dans le décodeur AAC");
      errors += m._aac_errors(this.decoder);
      if (n === 0) return;
      channels = m._aac_channels(this.decoder);
      sampleRate = m._aac_sample_rate(this.decoder);
      frames[i] = n;
      // Relu à chaque fois : la mémoire du module peut grandir, et l'ancienne vue devient vide.
      const at = m._aac_output(this.decoder) / 4;
      parts.push(m.HEAPF32.slice(at, at + n * channels));
      total += n * channels;
    });
    const pcm = new Float32Array(total);
    let at = 0;
    for (const part of parts) {
      pcm.set(part, at);
      at += part.length;
    }
    return { pcm, frames, channels, sampleRate, errors };
  }

  /** La disposition rendue par libavcodec (masque en ordre natif), 0 si elle n'est pas nommée. */
  layoutMask(): number {
    if (this.closed) return 0;
    // Les canaux nommés par libavcodec tiennent dans les 21 premiers bits ; la moitié haute ne sert
    // qu'aux dispositions exotiques, et un nombre JavaScript la garde exacte jusqu'à 2^53.
    return (this.wasm._aac_layout_hi(this.decoder) >>> 0) * 2 ** 32 + (this.wasm._aac_layout_lo(this.decoder) >>> 0);
  }

  reset(): void {
    if (this.closed) return;
    this.wasm._aac_reset(this.decoder);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.input) this.wasm._free(this.input);
    this.input = 0;
    this.inputSize = 0;
    this.wasm._aac_close(this.decoder);
  }
}

/** Télécharge le module (913 Ko, 386 compressés) sans l'instancier — pour un préchauffage. */
export async function warmAacWasm(): Promise<void> {
  await import("./aac-wasm.mjs");
}

// Le décodeur TrueHD/MLP de FFmpeg, compilé en WebAssembly (tools/truehd-wasm), vu d'ici.
//
// Rien de ce qui entoure le décodage n'est ici : ni lecture du fichier, ni temps. Ce module tourne
// tel quel dans le navigateur et dans Node, où les tests et le banc le font décoder les vrais
// fichiers de la bibliothèque — c'est ainsi qu'il a été comparé canal par canal à ffmpeg, à
// 0,01 dB près, le 21/09/2026.
import type { TrueHdModule } from "./truehd-wasm.mjs";

/** Un lot décodé : les échantillons de tous les blocs, et ce que chacun en a donné. */
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

/**
 * Le module, instancié une fois et gardé : chaque décodeur y ouvre son propre contexte. Instancier
 * 466 Ko de WebAssembly à chaque changement de piste, c'était une attente de plus pour rien. Une
 * instanciation qui échoue n'est pas gardée.
 */
let loaded: Promise<TrueHdModule> | null = null;

function instance(): Promise<TrueHdModule> {
  if (!loaded) {
    loaded = import("./truehd-wasm.mjs").then(({ default: createTrueHd }) => createTrueHd());
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

export class TrueHdCore {
  private input = 0;
  private inputSize = 0;
  /** Libéré : plus rien ne doit toucher à son contexte, sur une instance partagée par la page. */
  private closed = false;

  private constructor(
    private readonly wasm: TrueHdModule,
    private readonly decoder: number
  ) {}

  static async create(mlp: boolean): Promise<TrueHdCore> {
    const wasm = await instance();
    const decoder = wasm._thd_open(mlp ? 1 : 0);
    if (!decoder) throw new Error("le décodeur TrueHD n'a pas pu s'ouvrir");
    return new TrueHdCore(wasm, decoder);
  }

  decode(blocks: Uint8Array[]): DecodedBatch {
    if (this.closed) throw new Error("décodeur TrueHD fermé");
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
        this.inputSize = Math.max(block.length, 64 * 1024);
        this.input = m._malloc(this.inputSize);
      }
      m.HEAPU8.set(block, this.input);
      const n = m._thd_decode(this.decoder, this.input, block.length);
      if (n < 0) throw new Error("mémoire épuisée dans le décodeur TrueHD");
      errors += m._thd_errors(this.decoder);
      if (n === 0) return;
      channels = m._thd_channels(this.decoder);
      sampleRate = m._thd_sample_rate(this.decoder);
      frames[i] = n;
      // Relu à chaque fois : la mémoire du module peut grandir, et l'ancienne vue devient vide.
      const at = m._thd_output(this.decoder) / 4;
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

  /** Après un saut : le décodeur se resynchronise seul sur la synchronisation majeure suivante. */
  reset(): void {
    if (this.closed) return;
    this.wasm._thd_reset(this.decoder);
  }

  close(): void {
    // Une seule fois : fermer deux fois, c'est libérer deux fois la même mémoire.
    if (this.closed) return;
    this.closed = true;
    if (this.input) this.wasm._free(this.input);
    this.input = 0;
    this.inputSize = 0;
    this.wasm._thd_close(this.decoder);
  }
}

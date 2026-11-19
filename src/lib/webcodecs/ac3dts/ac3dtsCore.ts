// Les décodeurs AC-3, E-AC3 et DTS de FFmpeg 7.1.5 (tools/ac3dts-wasm) sur le fil où on les appelle :
// le fil principal quand le worker n'a pas pu naître (truehd/truehdDecoder.ts), et Node — tests et
// bancs. Le décodage d'un lot est celui du TrueHD (`decodeBlocks`, truehdWorker.mjs) : le module
// expose les mêmes fonctions, seul le codec choisi à l'ouverture change (0 AC-3, 1 E-AC3, 2 DTS).
import type { Ac3DtsModule } from "./ac3dts-wasm.mjs";
import { closeDecoder, decodeBlocks, type DecodeScratch, type DecodedBatch } from "../truehd/truehdWorker.mjs";

let loaded: Promise<Ac3DtsModule> | null = null;

function instance(): Promise<Ac3DtsModule> {
  if (!loaded) {
    loaded = import("./ac3dts-wasm.mjs").then(({ default: create }) => create());
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

/** Le numéro de codec que le module attend à l'ouverture. */
export type Ac3DtsCodec = 0 | 1 | 2;

export class Ac3DtsCore {
  private readonly scratch: DecodeScratch = { input: 0, inputSize: 0 };
  private closed = false;

  private constructor(
    private readonly wasm: Ac3DtsModule,
    private readonly decoder: number
  ) {}

  static async create(which: Ac3DtsCodec): Promise<Ac3DtsCore> {
    const wasm = await instance();
    const decoder = wasm._thd_open(which);
    if (!decoder) throw new Error("le décodeur AC-3/DTS n'a pas pu s'ouvrir");
    return new Ac3DtsCore(wasm, decoder);
  }

  decode(blocks: Uint8Array[]): DecodedBatch {
    if (this.closed) throw new Error("décodeur AC-3/DTS fermé");
    return decodeBlocks(this.wasm as never, this.decoder, this.scratch, blocks);
  }

  reset(): void {
    if (this.closed) return;
    this.wasm._thd_reset(this.decoder);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeDecoder(this.wasm as never, this.decoder, this.scratch);
  }
}

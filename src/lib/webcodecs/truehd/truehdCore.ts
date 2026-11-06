// Le décodeur TrueHD/MLP de FFmpeg, compilé en WebAssembly (tools/truehd-wasm), vu d'ici — sur le
// fil où on l'appelle : le fil principal quand le worker n'a pas pu naître (truehdDecoder.ts), et
// Node, où les tests et les bancs le font décoder les vrais fichiers de la bibliothèque.
//
// Rien de ce qui entoure le décodage n'est ici : ni lecture du fichier, ni temps. Le décodage d'un
// lot lui-même est dans truehdWorker.mjs, partagé avec le worker : les deux chemins exécutent le même
// code. C'est ainsi qu'il a été comparé canal par canal à ffmpeg, à 0,01 dB près, le 21/09/2026.
import type { TrueHdModule } from "./truehd-wasm.mjs";
import { closeDecoder, decodeBlocks, type DecodeScratch, type DecodedBatch } from "./truehdWorker.mjs";

export type { DecodedBatch };

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
  private readonly scratch: DecodeScratch = { input: 0, inputSize: 0 };
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
    return decodeBlocks(this.wasm, this.decoder, this.scratch, blocks);
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
    closeDecoder(this.wasm, this.decoder, this.scratch);
  }
}

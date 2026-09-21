// Types du module produit par tools/truehd-wasm/build.sh (fichier généré, non relu par TypeScript).

export interface TrueHdModule {
  _thd_open(mlp: number): number;
  _thd_decode(decoder: number, pointer: number, size: number): number;
  _thd_reset(decoder: number): void;
  _thd_output(decoder: number): number;
  _thd_channels(decoder: number): number;
  _thd_sample_rate(decoder: number): number;
  _thd_errors(decoder: number): number;
  _thd_close(decoder: number): void;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
}

export default function createTrueHd(options?: Record<string, unknown>): Promise<TrueHdModule>;

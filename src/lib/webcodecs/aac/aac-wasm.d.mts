// Types du module produit par tools/aac-wasm/build.sh (fichier généré, non relu par TypeScript).

export interface AacModule {
  _aac_open(asc: number, size: number): number;
  _aac_decode(decoder: number, pointer: number, size: number): number;
  _aac_reset(decoder: number): void;
  _aac_output(decoder: number): number;
  _aac_channels(decoder: number): number;
  _aac_sample_rate(decoder: number): number;
  _aac_errors(decoder: number): number;
  _aac_layout_lo(decoder: number): number;
  _aac_layout_hi(decoder: number): number;
  _aac_close(decoder: number): void;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
}

export default function createAac(options?: Record<string, unknown>): Promise<AacModule>;

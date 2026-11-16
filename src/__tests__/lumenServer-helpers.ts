// Outils partagés des tests de Lumen serveur : relire ce que le moteur produit, boîte par boîte.
//
// Pas de `.test.ts` : Vitest ne le lance pas seul. Le démultiplexeur MP4 du lecteur refuse un MP4
// fragmenté (par dessein) ; ce petit lecteur ne lit que les boîtes que `mediaSegment` écrit.

import { join } from "node:path";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { buildLumenIndex } from "@/lib/lumenServer/lumenIndex";
import type { LumenCutMode, LumenIndex } from "@/lib/lumenServer/format";

export const FIXTURES = "src/__tests__/fixtures/lumen";

export interface ParsedSample {
  decode: number;
  duration: number;
  size: number;
  flags: number;
  cto: number;
}

export interface ParsedFragment {
  sequence: number;
  trackId: number;
  baseDecode: number;
  samples: ParsedSample[];
  /** Les octets de chaque échantillon, lus dans le mdat qui suit. */
  data: Uint8Array[];
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

/** Les fragments (moof + mdat) d'un segment, dans l'ordre. */
export function parseFragments(bytes: Uint8Array): ParsedFragment[] {
  const out: ParsedFragment[] = [];
  let at = 0;
  let pending: (ParsedFragment & { moofAt: number; dataOffset: number }) | null = null;
  while (at + 8 <= bytes.length) {
    const size = u32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size < 8) throw new Error(`boîte ${type} de taille ${size}`);
    if (type === "moof") {
      const moof = bytes.subarray(at, at + size);
      const f = { sequence: 0, trackId: 0, baseDecode: 0, samples: [] as ParsedSample[], data: [] as Uint8Array[], moofAt: at, dataOffset: 0 };
      // mfhd est le premier enfant, traf le second ; leurs enfants dans l'ordre écrit par le muxer.
      let c = 8;
      while (c + 8 <= moof.length) {
        const csize = u32(moof, c);
        const ctype = String.fromCharCode(...moof.subarray(c + 4, c + 8));
        if (ctype === "mfhd") f.sequence = u32(moof, c + 12);
        if (ctype === "traf") {
          let t = c + 8;
          while (t + 8 <= c + csize) {
            const tsize = u32(moof, t);
            const ttype = String.fromCharCode(...moof.subarray(t + 4, t + 8));
            if (ttype === "tfhd") f.trackId = u32(moof, t + 12);
            if (ttype === "tfdt") f.baseDecode = u32(moof, t + 12) * 2 ** 32 + u32(moof, t + 16);
            if (ttype === "trun") {
              const count = u32(moof, t + 12);
              f.dataOffset = u32(moof, t + 16) | 0;
              let decode = f.baseDecode;
              for (let i = 0; i < count; i++) {
                const p = t + 20 + i * 16;
                const sample = { decode, duration: u32(moof, p), size: u32(moof, p + 4), flags: u32(moof, p + 8), cto: u32(moof, p + 12) | 0 };
                f.samples.push(sample);
                decode += sample.duration;
              }
            }
            t += tsize;
          }
        }
        c += csize;
      }
      pending = f;
    } else if (type === "mdat" && pending) {
      let d = pending.moofAt + pending.dataOffset;
      for (const s of pending.samples) {
        pending.data.push(bytes.subarray(d, d + s.size));
        d += s.size;
      }
      const { moofAt: _m, dataOffset: _d, ...fragment } = pending;
      void _m;
      void _d;
      out.push(fragment);
      pending = null;
    }
    at += size;
  }
  return out;
}

/** La fin de décodage d'un segment : le dernier échantillon plus sa durée écrite. */
export function endDecode(fragments: ParsedFragment[]): number {
  const last = fragments[fragments.length - 1];
  const sample = last.samples[last.samples.length - 1];
  return sample.decode + sample.duration;
}

/** L'index d'un fichier des fixtures, construit sur le fil du test. */
export async function fixtureIndex(name: string, targetUs?: number, cut?: LumenCutMode): Promise<{ index: LumenIndex; source: FileByteSource }> {
  const source = await FileByteSource.open(join(FIXTURES, name), { chunkSize: 16 * 1024, chunks: 64 });
  const index = await buildLumenIndex(source, source.identity, { targetUs, ...(cut ? { cut } : {}) });
  return { index, source };
}

import { describe, it, expect } from "vitest";
import { reconcileHvcc, parameterSetsIn } from "@/lib/webcodecs/hvcc";

/**
 * L'en-tête HEVC, corrigé par ce que les images portent (21/09/2026).
 *
 * *Dirty Dancing* déclare un PPS dans son en-tête et en porte un autre dès sa première image ;
 * sous `hvc1`, Safari ne lit que l'en-tête et décodait tout le film avec le mauvais.
 */

// Un NAL HEVC : deux octets d'en-tête (type << 1), puis une charge.
const nal = (type: number, ...payload: number[]) => new Uint8Array([type << 1, 1, ...payload]);
const VPS = nal(32, 0xaa);
const SPS = nal(33, 0xbb, 0xbb);
const PPS_DECLARED = nal(34, 0x01);
const PPS_REAL = nal(34, 0x02);
const SLICE = nal(19, 0x55, 0x55, 0x55);

/** Un hvcC : 22 octets d'en-tête (le 22e porte lengthSizeMinusOne = 3), puis les tableaux. */
function hvcc(arrays: [number, Uint8Array[]][]): Uint8Array {
  const head = new Array(22).fill(0);
  head[0] = 1;
  head[21] = 0xf3;
  const bytes = [...head, arrays.length];
  for (const [type, nals] of arrays) {
    bytes.push(0x80 | type, nals.length >> 8, nals.length & 0xff);
    for (const n of nals) bytes.push(n.length >> 8, n.length & 0xff, ...n);
  }
  return new Uint8Array(bytes);
}

/** Une image : des NAL préfixés par leur longueur sur quatre octets. */
function sample(...nals: Uint8Array[]): Uint8Array {
  const bytes: number[] = [];
  for (const n of nals) bytes.push(0, 0, n.length >> 8, n.length & 0xff, ...n);
  return new Uint8Array(bytes);
}

const declared = hvcc([[32, [VPS]], [33, [SPS]], [34, [PPS_DECLARED]], [39, [nal(39, 0x07)]]]);

describe("parameterSetsIn", () => {
  it("trouve les VPS, SPS et PPS d'une image, sans les tranches", () => {
    const found = parameterSetsIn(sample(VPS, SPS, PPS_REAL, SLICE), 4);
    expect([...found.keys()]).toEqual([32, 33, 34]);
    expect(found.get(34)).toEqual([PPS_REAL]);
  });
});

describe("reconcileHvcc", () => {
  it("remplace un PPS que l'image contredit, et garde tout le reste", () => {
    const fixed = reconcileHvcc(declared, sample(VPS, SPS, PPS_REAL, SLICE), 4)!;
    expect(fixed).not.toBeNull();
    // L'en-tête (profil, niveau, taille des longueurs) est intact.
    expect([...fixed.subarray(0, 22)]).toEqual([...declared.subarray(0, 22)]);
    const again = parameterSetsIn(sample(), 4);
    expect(again.size).toBe(0);
    // Le nouveau PPS y est, l'ancien non ; les messages SEI de l'en-tête sont gardés.
    const text = [...fixed].join(",");
    expect(text).toContain([...PPS_REAL].join(","));
    expect(text).not.toContain([...PPS_DECLARED].join(","));
    expect(text).toContain([...nal(39, 0x07)].join(","));
    expect(fixed[22]).toBe(4);
  });

  it("rend un en-tête qui dit déjà vrai à l'identique — rien à reconstruire", () => {
    expect(reconcileHvcc(declared, sample(VPS, SPS, PPS_DECLARED, SLICE), 4)).toBeNull();
  });

  it("ne touche à rien quand l'image ne porte aucun paramètre", () => {
    expect(reconcileHvcc(declared, sample(SLICE), 4)).toBeNull();
  });

  it("ne devine pas sur un en-tête illisible", () => {
    expect(reconcileHvcc(new Uint8Array([1, 2, 3]), sample(VPS, SPS, PPS_REAL), 4)).toBeNull();
  });

  it("ajoute un type que l'en-tête n'avait pas", () => {
    const withoutPps = hvcc([[32, [VPS]], [33, [SPS]]]);
    const fixed = reconcileHvcc(withoutPps, sample(PPS_REAL, SLICE), 4)!;
    expect(fixed[22]).toBe(3);
    expect([...fixed].join(",")).toContain([...PPS_REAL].join(","));
  });
});

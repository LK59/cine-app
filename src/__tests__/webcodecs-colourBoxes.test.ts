import { describe, it, expect } from "vitest";
import { colourBoxes, videoSampleEntry } from "@/lib/webcodecs/mp4SampleEntries";

/**
 * 22/09/2026 : notre MP4 ne décrivait pas son image — ni primaires, ni courbe, ni lumière — et un
 * épisode HDR10+ s'affichait trop sombre dans Chrome sous Windows. Les valeurs sont celles d'un
 * vrai fichier (BT.2020 PQ, mastering 1000 nits, MaxCLL 1641, MaxFALL 212), relues par ffprobe
 * dans la sortie du remultiplexeur.
 */
const HDR10 = {
  primaries: 9,
  transferCharacteristics: 16,
  matrixCoefficients: 9,
  range: 1,
  masteringMaxNits: 1000,
  masteringMinNits: 0.005,
  maxContentLightNits: 1641,
  maxFrameAverageNits: 212,
  masteringPrimaries: {
    r: [0.708, 0.292] as [number, number],
    g: [0.17, 0.797] as [number, number],
    b: [0.131, 0.046] as [number, number],
    white: [0.3127, 0.329] as [number, number],
  },
};

const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe("colourBoxes", () => {
  it("écrit colr, mdcv et clli depuis le conteneur", () => {
    const bytes = colourBoxes(HDR10);
    const s = text(bytes);
    const colr = s.indexOf("colr");
    const mdcv = s.indexOf("mdcv");
    const clli = s.indexOf("clli");
    expect([colr, mdcv, clli].every((at) => at > 0)).toBe(true);
    const v = view(bytes);
    // colr nclx : 9 / 16 / 9, plage limitée.
    expect(s.slice(colr + 4, colr + 8)).toBe("nclx");
    expect([v.getUint16(colr + 8), v.getUint16(colr + 10), v.getUint16(colr + 12), v.getUint8(colr + 14)]).toEqual([9, 16, 9, 0]);
    // mdcv : vert d'abord (0,17 → 8500), luminances en 0,0001 cd/m².
    expect(v.getUint16(mdcv + 4)).toBe(8500);
    expect(v.getUint32(mdcv + 4 + 16)).toBe(10_000_000);
    expect(v.getUint32(mdcv + 4 + 20)).toBe(50);
    // clli : MaxCLL, MaxFALL.
    expect([v.getUint16(clli + 4), v.getUint16(clli + 6)]).toEqual([1641, 212]);
  });

  it("n'invente rien : pas de mdcv sans les primaires, rien pour une couleur non précisée", () => {
    const partial = colourBoxes({ ...HDR10, masteringPrimaries: undefined });
    expect(text(partial)).not.toContain("mdcv");
    expect(text(partial)).toContain("clli");
    expect(colourBoxes({ primaries: 2, transferCharacteristics: 2, matrixCoefficients: 2 }).length).toBe(0);
    expect(colourBoxes(undefined).length).toBe(0);
  });

  it("les range dans l'entrée vidéo, après la configuration du décodeur", () => {
    const entry = text(videoSampleEntry("V_MPEGH/ISO/HEVC", new Uint8Array(23), 3840, 2160, null, HDR10));
    expect(entry.indexOf("hvcC")).toBeGreaterThan(0);
    expect(entry.indexOf("colr")).toBeGreaterThan(entry.indexOf("hvcC"));
    expect(entry).toContain("clli");
  });
});

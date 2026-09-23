import { describe, it, expect, vi } from "vitest";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

const parseMatroska = vi.fn(async () => ({ tracks: [] }));
const parseMp4 = vi.fn(async () => ({ tracks: [], mp4: {} }));
vi.mock("@/lib/webcodecs/matroska", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webcodecs/matroska")>()),
  parseMatroska: (...a: unknown[]) => parseMatroska(...(a as [])),
}));
vi.mock("@/lib/webcodecs/mp4Demux", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webcodecs/mp4Demux")>()),
  parseMp4: (...a: unknown[]) => parseMp4(...(a as [])),
}));

// Le lecteur d'échantillons Matroska, remplacé par une file d'échantillons donnée par chaque cas.
const queued: { trackNumber: number; data: Uint8Array }[] = [];
vi.mock("@/lib/webcodecs/sampleReader", () => ({
  SampleReader: class {
    exhausted = false;
    async next() {
      return queued.shift() ?? null;
    }
    seekTo() {}
  },
}));

import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { hevcRecordHasParameterSets } from "@/lib/webcodecs/codecConfig";

/** Une source qui compte ce qu'on lui demande. */
function source(head: number[]) {
  const reads: [number, number][] = [];
  const bytes = new Uint8Array(12);
  bytes.set(head);
  const src = {
    size: 1_000_000,
    read: async (offset: number, length: number) => {
      reads.push([offset, length]);
      return bytes.subarray(0, length);
    },
    close: () => {},
  } as unknown as ByteSource;
  return { src, reads };
}

const MKV = [0x1a, 0x45, 0xdf, 0xa3];
const MP4 = [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70];

describe("openMediaFile", () => {
  it("reconnaît le conteneur une fois, puis ne relit plus le début du fichier pour le savoir", async () => {
    // 22/09/2026 : après un saut, les douze premiers octets n'étaient plus en cache, et chaque
    // changement de piste repayait un aller-retour réseau pour une réponse déjà connue.
    const first = source(MKV);
    await openMediaFile(first.src, "/stream/a.mkv");
    expect(first.reads).toHaveLength(1);

    const again = source(MKV);
    await openMediaFile(again.src, "/stream/a.mkv");
    expect(again.reads).toHaveLength(0);
    expect(parseMatroska).toHaveBeenCalledTimes(2);
  });

  it("garde chaque fichier dans son conteneur", async () => {
    const mp4 = source(MP4);
    await openMediaFile(mp4.src, "/stream/b.mp4");
    const again = source(MP4);
    await openMediaFile(again.src, "/stream/b.mp4");
    expect(again.reads).toHaveLength(0);
    expect(parseMp4).toHaveBeenCalledTimes(2);
  });

  it("relit toujours sans clé", async () => {
    const anonymous = source(MKV);
    await openMediaFile(anonymous.src);
    expect(anonymous.reads).toHaveLength(1);
  });
});

/** Une unité NAL HEVC de ce type, précédée de sa longueur sur 4 octets. */
function nal(type: number, body: number[] = [0xaa, 0xbb]): number[] {
  const unit = [type << 1, 0x01, ...body];
  return [0, 0, 0, unit.length, ...unit];
}

/** Un `hvcC` réduit à son en-tête : profil Main 10, niveau 4, longueurs sur 4 octets, zéro tableau. */
const HEADER_ONLY = new Uint8Array([
  0x01, 0x02, 0x20, 0x00, 0x00, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x78, 0xf0, 0x00, 0xfe, 0xfd, 0xfa, 0xfa, 0x00, 0x00, 0x0f, 0x00,
]);

// Peaky Blinders : L'Immortel (24/09/2026) — un hvcC de 23 octets, les paramètres dans le flux
// seulement, et Safari qui ne sortait jamais la première image.
describe("un en-tête HEVC sans jeux de paramètres", () => {
  const track = () => ({ number: 1, type: "video", codecId: "V_MPEGH/ISO/HEVC", codecPrivate: HEADER_ONLY.slice() });

  it("est complété depuis la première image clé", async () => {
    const video = track();
    parseMatroska.mockResolvedValueOnce({ tracks: [video], firstClusterOffset: 100 } as never);
    queued.push(
      { trackNumber: 2, data: new Uint8Array([1, 2, 3]) },
      { trackNumber: 1, data: new Uint8Array([...nal(32), ...nal(33), ...nal(34), ...nal(39), ...nal(19, [1, 2, 3, 4])]) }
    );
    await openMediaFile(source(MKV).src);

    expect(hevcRecordHasParameterSets(video.codecPrivate)).toBe(true);
    // L'en-tête d'origine est gardé : profil, niveau, taille des longueurs.
    expect([...video.codecPrivate.subarray(0, 22)]).toEqual([...HEADER_ONLY.subarray(0, 22)]);
    expect(video.codecPrivate[22]).toBe(3);
  });

  it("ne lit rien quand l'en-tête est déjà complet", async () => {
    const video = track();
    parseMatroska.mockResolvedValueOnce({ tracks: [video], firstClusterOffset: 100 } as never);
    queued.push({ trackNumber: 1, data: new Uint8Array([...nal(32), ...nal(33), ...nal(34), ...nal(19)]) });
    await openMediaFile(source(MKV).src);
    const complete = video.codecPrivate;

    parseMatroska.mockResolvedValueOnce({ tracks: [video], firstClusterOffset: 100 } as never);
    queued.length = 0;
    queued.push({ trackNumber: 1, data: new Uint8Array([9, 9, 9]) });
    await openMediaFile(source(MKV).src);
    expect(video.codecPrivate).toBe(complete);
    expect(queued).toHaveLength(1);
    queued.length = 0;
  });

  it("laisse le fichier tel quel s'il ne trouve rien", async () => {
    const video = track();
    parseMatroska.mockResolvedValueOnce({ tracks: [video], firstClusterOffset: 100 } as never);
    queued.push({ trackNumber: 1, data: new Uint8Array([...nal(19)]) });
    await openMediaFile(source(MKV).src);
    expect([...video.codecPrivate]).toEqual([...HEADER_ONLY]);
  });
});


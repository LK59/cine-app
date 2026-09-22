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

import { openMediaFile } from "@/lib/webcodecs/mediaFile";

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

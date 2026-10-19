import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fragmentIndexAt, parseInit, scanFragments } from "@/lib/offline/fmp4";

/**
 * Le MP4 fragmenté des téléchargements hors ligne, sur un fichier de la forme exacte que Jellyfin
 * livre (`src/__tests__/fixtures/offline/generate.sh` : `frag_keyframe+empty_moov+delay_moov`, HEVC `hev1` + AAC).
 */
const file = new Uint8Array(fs.readFileSync(path.join(process.cwd(), "src/__tests__/fixtures/offline/jellyfin-like.mp4")));
const reader = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.slice(offset, Math.min(bytes.length, offset + length));

describe("parseInit", () => {
  it("l'en-tête : pistes, codecs, fin, et hev1 renommé hvc1 sans toucher au reste", () => {
    const init = parseInit(file)!;
    expect(init.end).toBe(3742);
    expect(init.tracks.map((t) => [t.id, t.kind, t.timescale])).toEqual([
      [1, "video", 12288],
      [2, "audio", 48000],
    ]);
    expect(init.tracks[0].codec).toMatch(/^hvc1\.1\.6\.L\d+/);
    expect(init.tracks[1].codec).toBe("mp4a.40.2");
    expect(init.mime).toBe(`video/mp4; codecs="${init.tracks[0].codec},mp4a.40.2"`);
    const text = Buffer.from(init.bytes).toString("latin1");
    expect(text).not.toContain("hev1");
    expect(text).toContain("hvc1");
    // Quatre octets changés, pas un de plus, et le fichier d'origine intact.
    let diff = 0;
    for (let i = 0; i < init.end; i++) if (init.bytes[i] !== file[i]) diff++;
    expect(diff).toBeLessThanOrEqual(4);
    expect(Buffer.from(file.slice(0, init.end)).toString("latin1")).toContain("hev1");
  });

  it("un en-tête pas encore arrivé en entier : null, pas d'erreur", () => {
    expect(parseInit(file.slice(0, 100))).toBeNull();
    expect(parseInit(file.slice(0, 3000))).toBeNull();
  });
});

describe("scanFragments", () => {
  const video = parseInit(file)!.tracks[0];

  it("tout le fichier : trois fragments, leurs instants, le mfra final sauté", async () => {
    const { fragments, next } = await scanFragments(reader(file), 3742, file.length, video);
    expect(fragments.map((f) => f.offset)).toEqual([3742, 14026, 23869]);
    expect(fragments.map((f) => f.time)).toEqual([0, 1, 1.875]);
    expect(fragments[0].size).toBe(14026 - 3742);
    expect(next).toBe(file.length);
  });

  it("un fichier qui arrive : s'arrête au premier fragment incomplet et reprend de là", async () => {
    const partial = file.slice(0, 20000);
    const first = await scanFragments(reader(partial), 3742, partial.length, video);
    expect(first.fragments.map((f) => f.offset)).toEqual([3742]);
    expect(first.next).toBe(14026);
    const rest = await scanFragments(reader(file), first.next, file.length, video);
    expect(rest.fragments.map((f) => f.offset)).toEqual([14026, 23869]);
  });
});

describe("fragmentIndexAt", () => {
  const fragments = [
    { offset: 0, size: 1, time: 0 },
    { offset: 1, size: 1, time: 10 },
    { offset: 2, size: 1, time: 20 },
  ];
  it("le dernier fragment qui commence avant l'instant", () => {
    expect(fragmentIndexAt(fragments, -1)).toBe(0);
    expect(fragmentIndexAt(fragments, 0)).toBe(0);
    expect(fragmentIndexAt(fragments, 9.99)).toBe(0);
    expect(fragmentIndexAt(fragments, 10)).toBe(1);
    expect(fragmentIndexAt(fragments, 25)).toBe(2);
    expect(fragmentIndexAt([], 5)).toBe(-1);
  });
});

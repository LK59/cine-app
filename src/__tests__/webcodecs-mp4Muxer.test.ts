import { describe, it, expect } from "vitest";
import { initSegment, mediaSegment, __testing, type MuxSample, type MuxTrackInfo } from "@/lib/webcodecs/mp4Muxer";

const { packLanguage } = __testing;

const videoTrack: MuxTrackInfo = {
  id: 1,
  kind: "video",
  timescale: 90000,
  sampleEntry: new Uint8Array([0, 0, 0, 12, 0x68, 0x76, 0x63, 0x31, 1, 2, 3, 4]), // a stand-in hvc1
  width: 1920,
  height: 1080,
  language: "und",
};

const audioTrack: MuxTrackInfo = {
  ...videoTrack,
  id: 2,
  kind: "audio",
  timescale: 48000,
  width: 0,
  height: 0,
  language: "fra",
};

function sample(overrides: Partial<MuxSample> & { data: Uint8Array }): MuxSample {
  return { decodeTime: 0, duration: 3000, compositionOffset: 0, isKeyframe: false, ...overrides };
}

/** Every box in the tree, with its offset — used to assert the file is walkable end to end. */
function walk(buffer: Uint8Array, start = 0, end = buffer.length, depth = 0): { type: string; offset: number; depth: number }[] {
  const found: { type: string; offset: number; depth: number }[] = [];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "dinf"]);
  for (let offset = start; offset + 8 <= end; ) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...buffer.subarray(offset + 4, offset + 8));
    // A size that runs past the parent means an arithmetic error somewhere upstream; failing here
    // is the whole point of walking rather than spot-checking individual boxes.
    expect(size, `box ${type} at ${offset} has an impossible size`).toBeGreaterThanOrEqual(8);
    expect(offset + size, `box ${type} at ${offset} runs past its parent`).toBeLessThanOrEqual(end);
    found.push({ type, offset, depth });
    if (containers.has(type)) found.push(...walk(buffer, offset + 8, offset + size, depth + 1));
    offset += size;
  }
  return found;
}

function readBox(buffer: Uint8Array, type: string): { offset: number; payload: Uint8Array } {
  const hit = walk(buffer).find((b) => b.type === type);
  if (!hit) throw new Error(`box ${type} absente`);
  const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(hit.offset);
  return { offset: hit.offset, payload: buffer.subarray(hit.offset + 8, hit.offset + size) };
}

describe("initSegment", () => {
  it("produces a tree whose every box size lands exactly on the next one", () => {
    const boxes = walk(initSegment(videoTrack, 7200));
    // walk() throws on any inconsistency; reaching here means the whole file is traversable.
    const types = boxes.map((b) => b.type);
    expect(types.slice(0, 2)).toEqual(["ftyp", "moov"]);
    for (const required of ["mvhd", "trak", "tkhd", "mdia", "mdhd", "hdlr", "minf", "stbl", "stsd", "mvex", "trex"]) {
      expect(types, `${required} manquante`).toContain(required);
    }
  });

  it("declares the video handler and header for video, the sound ones for audio", () => {
    const video = initSegment(videoTrack, 10);
    expect(walk(video).map((b) => b.type)).toContain("vmhd");
    expect(new TextDecoder().decode(readBox(video, "hdlr").payload.subarray(8, 12))).toBe("vide");

    const audio = initSegment(audioTrack, 10);
    const audioTypes = walk(audio).map((b) => b.type);
    expect(audioTypes).toContain("smhd");
    expect(audioTypes).not.toContain("vmhd");
    expect(new TextDecoder().decode(readBox(audio, "hdlr").payload.subarray(8, 12))).toBe("soun");
  });

  it("states the length once, in mehd, and leaves the header durations at zero", () => {
    const segment = initSegment(videoTrack, 7200);
    const mehd = new DataView(readBox(segment, "mehd").payload.buffer, readBox(segment, "mehd").payload.byteOffset);
    expect(Number(mehd.getBigUint64(4))).toBe(7_200_000); // seconds at the movie timescale

    const mvhd = readBox(segment, "mvhd").payload;
    expect(new DataView(mvhd.buffer, mvhd.byteOffset).getUint32(16)).toBe(0);
  });

  it("carries the sample entry through into stsd, and the track's own clock into mdhd", () => {
    const segment = initSegment(videoTrack, 10);
    const stsd = readBox(segment, "stsd").payload;
    expect(Array.from(stsd.subarray(8))).toEqual(Array.from(videoTrack.sampleEntry));

    const mdhd = readBox(segment, "mdhd").payload;
    expect(new DataView(mdhd.buffer, mdhd.byteOffset).getUint32(12)).toBe(90000);
  });

  it("writes the frame size as 16.16 fixed point in tkhd, after a well-formed matrix", () => {
    const tkhd = readBox(initSegment(videoTrack, 10), "tkhd").payload;
    const view = new DataView(tkhd.buffer, tkhd.byteOffset);
    expect(view.getUint32(76) / 65536).toBe(1920);
    expect(view.getUint32(80) / 65536).toBe(1080);

    // The matrix ends in 2.30 fixed point, not 16.16 — a wrong 1.0 here is a degenerate transform
    // that shifts every field after it in a way that still parses. Both are checked together
    // because that is exactly how the mistake showed up.
    expect(view.getUint32(40)).toBe(0x00010000); // a, 16.16
    expect(view.getUint32(56)).toBe(0x00010000); // d, 16.16
    expect(view.getUint32(72)).toBe(0x40000000); // w, 2.30
  });

  it("packs a language into the five-bit-per-letter form, falling back to und", () => {
    expect(packLanguage("fra")).toBe(((6 << 10) | (18 << 5) | 1));
    expect(packLanguage("und")).toBe(packLanguage("xx"));
    expect(packLanguage("FRA")).toBe(packLanguage("und"));
  });
});

describe("mediaSegment", () => {
  const samples = [
    sample({ data: new Uint8Array([1, 1, 1, 1]), decodeTime: 0, isKeyframe: true, compositionOffset: 6000 }),
    sample({ data: new Uint8Array([2, 2]), decodeTime: 3000, compositionOffset: 0 }),
    sample({ data: new Uint8Array([3, 3, 3]), decodeTime: 6000, compositionOffset: 3000 }),
  ];

  it("points the data offset at exactly the first byte of the first sample", () => {
    // The bug this exists for: the offset is written inside the very box whose length it depends
    // on. Off by even one byte and a decoder reads a shifted stream that mostly looks like video.
    const segment = mediaSegment(videoTrack, 1, samples);
    const trun = readBox(segment, "trun").payload;
    const dataOffset = new DataView(trun.buffer, trun.byteOffset).getInt32(8);

    const moofOffset = readBox(segment, "moof").offset;
    const firstByte = moofOffset + dataOffset;
    expect(Array.from(segment.subarray(firstByte, firstByte + 4))).toEqual([1, 1, 1, 1]);

    // And the mdat payload starts there too, i.e. the offset was not merely self-consistent.
    const mdat = readBox(segment, "mdat");
    expect(mdat.offset + 8).toBe(firstByte);
    expect(Array.from(mdat.payload)).toEqual([1, 1, 1, 1, 2, 2, 3, 3, 3]);
  });

  it("writes each sample's duration, size, sync flag and composition offset", () => {
    const segment = mediaSegment(videoTrack, 1, samples);
    const trun = readBox(segment, "trun").payload;
    const view = new DataView(trun.buffer, trun.byteOffset);
    expect(view.getUint32(4)).toBe(3); // sample count

    const entries = samples.map((_, index) => {
      const at = 12 + index * 16;
      return {
        duration: view.getUint32(at),
        size: view.getUint32(at + 4),
        flags: view.getUint32(at + 8),
        composition: view.getInt32(at + 12), // signed: version 1 trun
      };
    });
    expect(entries.map((e) => e.size)).toEqual([4, 2, 3]);
    expect(entries.map((e) => e.duration)).toEqual([3000, 3000, 3000]);
    expect(entries.map((e) => e.composition)).toEqual([6000, 0, 3000]);
    expect(entries[0].flags).toBe(0x02000000); // sync
    expect(entries[1].flags).toBe(0x01010000); // not sync
  });

  it("anchors the fragment on its first sample's decode time", () => {
    const later = samples.map((s) => ({ ...s, decodeTime: s.decodeTime + 900_000 }));
    const tfdt = readBox(mediaSegment(videoTrack, 4, later), "tfdt").payload;
    expect(Number(new DataView(tfdt.buffer, tfdt.byteOffset).getBigUint64(4))).toBe(900_000);
  });

  it("numbers the fragment and stays walkable whatever the sample count", () => {
    const many = Array.from({ length: 240 }, (_, i) =>
      sample({ data: new Uint8Array(i + 1), decodeTime: i * 3000, isKeyframe: i === 0 })
    );
    const segment = mediaSegment(videoTrack, 7, many);
    walk(segment); // throws on any size inconsistency at this larger scale

    const mfhd = readBox(segment, "mfhd").payload;
    expect(new DataView(mfhd.buffer, mfhd.byteOffset).getUint32(4)).toBe(7);

    const trun = readBox(segment, "trun").payload;
    const dataOffset = new DataView(trun.buffer, trun.byteOffset).getInt32(8);
    expect(readBox(segment, "moof").offset + dataOffset).toBe(readBox(segment, "mdat").offset + 8);
  });

  it("writes durations that add back up to exactly the decode timeline it was given", () => {
    // A trun carries only the first decode time; the rest are the running total of the durations.
    // So a sample's declared duration has to be the gap to the next decode time. Frame durations
    // happen to equal those gaps at a constant frame rate — this uses uneven ones, where they do
    // not, which is the case that caught the bug on a 23.976 fps file.
    const uneven = [
      sample({ data: new Uint8Array(3), decodeTime: 0, duration: 41_000, isKeyframe: true }),
      sample({ data: new Uint8Array(3), decodeTime: 41_000, duration: 42_000 }),
      sample({ data: new Uint8Array(3), decodeTime: 83_000, duration: 41_000 }),
      sample({ data: new Uint8Array(3), decodeTime: 125_000, duration: 42_000 }),
    ];
    const segment = mediaSegment(videoTrack, 1, uneven);
    const trun = readBox(segment, "trun").payload;
    const view = new DataView(trun.buffer, trun.byteOffset);

    let accumulated = 0;
    for (let i = 0; i < uneven.length; i++) {
      expect(accumulated, `decode time of sample ${i}`).toBe(uneven[i].decodeTime);
      accumulated += view.getUint32(12 + i * 16);
    }
    // The last sample has no successor, so its own duration closes the segment.
    expect(accumulated).toBe(125_000 + 42_000);
  });

  it("refuses an empty fragment rather than emitting one a decoder would stall on", () => {
    expect(() => mediaSegment(videoTrack, 1, [])).toThrow(/vide/);
  });
});

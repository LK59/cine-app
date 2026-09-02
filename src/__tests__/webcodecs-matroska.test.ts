import { describe, it, expect } from "vitest";
import { MemoryByteSource } from "@/lib/webcodecs/byteSource";
import { parseMatroska, clusterOffsetForTime, parseBlock } from "@/lib/webcodecs/matroska";
import { SampleReader } from "@/lib/webcodecs/sampleReader";
import { readElementId, readVarSize, readVarInt } from "@/lib/webcodecs/ebml";

// ---------------------------------------------------------------------------
// A tiny Matroska writer, so the demuxer is tested against bytes laid out the
// way a real muxer lays them out rather than against a mock of itself.
// ---------------------------------------------------------------------------

function vint(value: number, width = 0): Uint8Array {
  let w = width;
  if (!w) {
    w = 1;
    while (value >= 2 ** (7 * w) - 1 && w < 8) w++;
  }
  const out = new Uint8Array(w);
  let v = value;
  for (let i = w - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (w - 1);
  return out;
}

function idBytes(id: number): Uint8Array {
  const parts: number[] = [];
  let v = id;
  while (v > 0) {
    parts.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(parts);
}

function el(id: number, payload: Uint8Array): Uint8Array {
  const head = idBytes(id);
  const size = vint(payload.length);
  const out = new Uint8Array(head.length + size.length + payload.length);
  out.set(head, 0);
  out.set(size, head.length);
  out.set(payload, head.length + size.length);
  return out;
}

function uint(value: number, bytes = 1): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

function f64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function simpleBlock(track: number, relative: number, isKey: boolean, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = 0x80 | track;
  new DataView(header.buffer).setInt16(1, relative);
  header[3] = isKey ? 0x80 : 0x00;
  return el(0xa3, concat(header, data));
}

const CODEC_PRIVATE = new Uint8Array([1, 2, 3, 4]);

function buildFile(): Uint8Array {
  const ebmlHeader = el(0x1a45dfa3, el(0x4286, uint(1)));

  const info = el(
    0x1549a966,
    concat(el(0x2ad7b1, uint(1_000_000, 4)), el(0x4489, f64(12_000))) // 1ms ticks x 12000 = 12s
  );

  const videoTrack = el(
    0xae,
    concat(
      el(0xd7, uint(1)),
      el(0x83, uint(1)),
      el(0x86, new TextEncoder().encode("V_MPEGH/ISO/HEVC")),
      el(0x63a2, CODEC_PRIVATE),
      el(0x88, uint(1)),
      el(0xe0, concat(
        el(0xb0, uint(1920, 2)),
        el(0xba, uint(1080, 2)),
        el(0x55b0, concat(el(0x55ba, uint(16)), el(0x55bb, uint(9)), el(0x55b2, uint(10))))
      ))
    )
  );
  const audioTrack = el(
    0xae,
    concat(
      el(0xd7, uint(2)),
      el(0x83, uint(2)),
      el(0x86, new TextEncoder().encode("A_EAC3")),
      el(0x22b59c, new TextEncoder().encode("fra")),
      el(0x536e, new TextEncoder().encode("VFF")),
      el(0xe1, concat(el(0xb5, f64(48000)), el(0x9f, uint(6))))
    )
  );
  const tracks = el(0x1654ae6b, concat(videoTrack, audioTrack));

  const cluster0 = el(
    0x1f43b675,
    concat(
      el(0xe7, uint(0)),
      simpleBlock(1, 0, true, new Uint8Array([0xaa])),
      simpleBlock(2, 0, true, new Uint8Array([0xbb])),
      simpleBlock(1, 40, false, new Uint8Array([0xcc]))
    )
  );
  const cluster1 = el(
    0x1f43b675,
    concat(el(0xe7, uint(5000, 2)), simpleBlock(1, 0, true, new Uint8Array([0xdd])))
  );

  // Laid out the way a real muxer lays a file out: a SeekHead first, then the header elements,
  // then the media, then the cue index at the very end. That ordering is the whole reason the
  // parser needs the SeekHead — a forward walk stops at the first cluster and would otherwise
  // never reach the index, leaving the file unseekable.
  //
  // Positions are written at a fixed width so that filling in the real values below cannot
  // change any element's length, which would invalidate the very offsets being computed.
  const cuesFor = (cluster0Position: number, cluster1Position: number) =>
    el(
      0x1c53bb6b,
      concat(
        el(0xbb, concat(el(0xb3, uint(0)), el(0xb7, concat(el(0xf7, uint(1)), el(0xf1, uint(cluster0Position, 6)))))),
        el(0xbb, concat(el(0xb3, uint(5000, 2)), el(0xb7, concat(el(0xf7, uint(1)), el(0xf1, uint(cluster1Position, 6))))))
      )
    );
  const seekHeadFor = (cuesPosition: number) =>
    el(
      0x114d9b74,
      el(0x4dbb, concat(el(0x53ab, idBytes(0x1c53bb6b)), el(0x53ac, uint(cuesPosition, 6))))
    );

  const seekHeadLength = seekHeadFor(0).length;
  const cluster0Position = seekHeadLength + info.length + tracks.length;
  const cluster1Position = cluster0Position + cluster0.length;
  const cuesPosition = cluster1Position + cluster1.length;

  const segmentPayload = concat(
    seekHeadFor(cuesPosition),
    info,
    tracks,
    cluster0,
    cluster1,
    cuesFor(cluster0Position, cluster1Position)
  );
  return concat(ebmlHeader, el(0x18538067, segmentPayload));
}

describe("EBML primitives", () => {
  it("reads element ids keeping their marker bit", () => {
    expect(readElementId(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0)).toEqual({ value: 0x1a45dfa3, width: 4 });
    expect(readElementId(new Uint8Array([0xae]), 0)).toEqual({ value: 0xae, width: 1 });
  });

  it("reads sizes dropping theirs, and reports the unknown-size encoding as null", () => {
    expect(readVarSize(new Uint8Array([0x84]), 0)).toEqual({ value: 4, width: 1 });
    expect(readVarSize(new Uint8Array([0x40, 0x7f]), 0)).toEqual({ value: 127, width: 2 });
    expect(readVarSize(new Uint8Array([0xff]), 0)).toEqual({ value: null, width: 1 });
    expect(readVarSize(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0)?.value).toBeNull();
  });

  it("reads the signed variant used by lacing", () => {
    expect(readVarInt(new Uint8Array([0xbf]), 0)?.value).toBe(0); // 0x3f - 63
    expect(readVarInt(new Uint8Array([0x80]), 0)?.value).toBe(-63);
  });

  it("rejects a byte with no marker bit instead of guessing", () => {
    expect(readElementId(new Uint8Array([0x00, 0x00]), 0)).toBeNull();
  });
});

describe("parseMatroska", () => {
  const source = new MemoryByteSource(buildFile());

  // Duration is stored in TimestampScale ticks, not seconds. Asserting the raw number here is
  // what let a real 2-hour film report a duration of 7 176 362 seconds.
  it("converts the duration from timestamp ticks to seconds", async () => {
    const file = await parseMatroska(source);
    expect(file.timestampScaleNs).toBe(1_000_000);
    expect(file.durationSeconds).toBe(12);
  });

  it("reads both tracks with their codec configuration", async () => {
    const file = await parseMatroska(source);
    expect(file.tracks).toHaveLength(2);

    const video = file.tracks.find((t) => t.type === "video")!;
    expect(video.codecId).toBe("V_MPEGH/ISO/HEVC");
    expect(video.isDefault).toBe(true);
    expect(video.video).toMatchObject({ width: 1920, height: 1080 });
    // The colour metadata is what decides HDR handling later on.
    expect(video.video?.colour).toMatchObject({ transferCharacteristics: 16, primaries: 9, bitsPerChannel: 10 });
    // CodecPrivate configures the decoder, so it must survive as its own copy.
    expect(Array.from(video.codecPrivate ?? [])).toEqual([1, 2, 3, 4]);

    const audio = file.tracks.find((t) => t.type === "audio")!;
    expect(audio.codecId).toBe("A_EAC3");
    expect(audio.language).toBe("fra");
    expect(audio.name).toBe("VFF");
    expect(audio.audio).toMatchObject({ sampleRate: 48000, channels: 6 });
  });

  it("finds the cue index even though it sits after the media data", async () => {
    const file = await parseMatroska(source);
    expect(file.cues).toHaveLength(2);
    expect(file.cues.map((c) => c.timeUs)).toEqual([0, 5_000_000]);
  });

  it("picks the cue at or before the requested time", async () => {
    const file = await parseMatroska(source);
    expect(clusterOffsetForTime(file, 0)).toBe(file.cues[0].clusterOffset);
    expect(clusterOffsetForTime(file, 4_999_999)).toBe(file.cues[0].clusterOffset);
    expect(clusterOffsetForTime(file, 5_000_000)).toBe(file.cues[1].clusterOffset);
    expect(clusterOffsetForTime(file, 99_000_000)).toBe(file.cues[1].clusterOffset);
  });

  it("refuses a file that isn't Matroska rather than reading garbage as structure", async () => {
    await expect(parseMatroska(new MemoryByteSource(new Uint8Array([0, 1, 2, 3])))).rejects.toThrow();
  });
});

describe("SampleReader", () => {
  it("walks clusters in order, with timestamps scaled to microseconds", async () => {
    const source = new MemoryByteSource(buildFile());
    const file = await parseMatroska(source);
    const reader = new SampleReader(source, file, file.firstClusterOffset!);

    const samples = [];
    for (;;) {
      const s = await reader.next();
      if (!s) break;
      samples.push(s);
    }

    expect(samples.map((s) => [s.trackNumber, s.timestampUs, s.isKey])).toEqual([
      [1, 0, true],
      [2, 0, true],
      [1, 40_000, false],
      [1, 5_000_000, true],
    ]);
    expect(Array.from(samples[0].data)).toEqual([0xaa]);
  });

  it("resumes at a cue offset when seeking", async () => {
    const source = new MemoryByteSource(buildFile());
    const file = await parseMatroska(source);
    const reader = new SampleReader(source, file, file.firstClusterOffset!);

    reader.seekTo(clusterOffsetForTime(file, 5_000_000)!);
    const first = await reader.next();
    expect(first).toMatchObject({ trackNumber: 1, timestampUs: 5_000_000, isKey: true });
    expect(await reader.next()).toBeNull();
    expect(reader.exhausted).toBe(true);
  });
});

describe("parseBlock lacing", () => {
  // Lacing packs several frames into one block. Audio muxers use it; getting it wrong turns a
  // valid track into noise, which is why all three schemes are covered here.
  function laced(flags: number, body: number[]): Uint8Array {
    return concat(new Uint8Array([0x81, 0x00, 0x00, flags]), new Uint8Array(body));
  }

  it("returns a single frame when there is no lacing", () => {
    const out = parseBlock(laced(0x00, [1, 2, 3]), 0, 1_000_000, true, false);
    expect(out).toHaveLength(1);
    expect(Array.from(out[0].data)).toEqual([1, 2, 3]);
  });

  it("splits fixed lacing into equal frames", () => {
    const out = parseBlock(laced(0x04, [1, 0xaa, 0xbb]), 0, 1_000_000, true, false);
    expect(out.map((s) => Array.from(s.data))).toEqual([[0xaa], [0xbb]]);
  });

  it("splits Xiph lacing", () => {
    const out = parseBlock(laced(0x02, [1, 2, 0xaa, 0xbb, 0xcc]), 0, 1_000_000, true, false);
    expect(out.map((s) => Array.from(s.data))).toEqual([[0xaa, 0xbb], [0xcc]]);
  });

  it("splits EBML lacing", () => {
    const out = parseBlock(laced(0x06, [1, 0x82, 0xaa, 0xbb, 0xcc]), 0, 1_000_000, true, false);
    expect(out.map((s) => Array.from(s.data))).toEqual([[0xaa, 0xbb], [0xcc]]);
  });

  it("gives every frame of a lace the same timestamp as its block", () => {
    const out = parseBlock(laced(0x04, [1, 0xaa, 0xbb]), 100, 1_000_000, true, false);
    expect(out.every((s) => s.timestampUs === 100_000)).toBe(true);
  });
});

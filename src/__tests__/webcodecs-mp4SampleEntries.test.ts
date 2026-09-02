import { describe, it, expect } from "vitest";
import { audioSampleEntryFor, dac3, dec3, videoSampleEntry, __testing } from "@/lib/webcodecs/mp4SampleEntries";

const { BitWriter } = __testing;

/** Reads back the bit fields a description box is made of, to assert on them individually. */
function bits(bytes: Uint8Array) {
  let position = 0;
  return (count: number) => {
    let value = 0;
    for (let i = 0; i < count; i++, position++) {
      value = (value << 1) | ((bytes[position >> 3] >> (7 - (position & 7))) & 1);
    }
    return value;
  };
}

/** Finds a child box by type and returns its payload, so tests read the file the way a player does. */
function findBox(buffer: Uint8Array, type: string): Uint8Array | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let offset = 0; offset + 8 <= buffer.length; ) {
    const size = view.getUint32(offset);
    const name = String.fromCharCode(...buffer.subarray(offset + 4, offset + 8));
    if (name === type) return buffer.subarray(offset + 8, offset + size);
    if (size < 8) break;
    offset += size;
  }
  return null;
}

/** Builds an AC-3 syncframe header with the fields laid out exactly as ETSI TS 102 366 orders them. */
function ac3Frame(f: { fscod: number; frmsizecod: number; bsid: number; bsmod: number; acmod: number; lfeon: number }) {
  const w = new BitWriter();
  w.write(0x0b77, 16).write(0xffff, 16);
  w.write(f.fscod, 2).write(f.frmsizecod, 6).write(f.bsid, 5).write(f.bsmod, 3).write(f.acmod, 3);
  // Written under the same conditions the parser must reproduce; the whole point of the test is
  // that a parser skipping the wrong count lands on the wrong bit for lfeon.
  if ((f.acmod & 0x01) !== 0 && f.acmod !== 0x01) w.write(0b10, 2);
  if ((f.acmod & 0x04) !== 0) w.write(0b01, 2);
  if (f.acmod === 0x02) w.write(0b11, 2);
  w.write(f.lfeon, 1);
  return w.bytes();
}

function eac3Frame(f: { frmsiz: number; fscod: number; numblkscod: number; acmod: number; lfeon: number; bsid: number }) {
  const w = new BitWriter();
  w.write(0x0b77, 16);
  w.write(0, 2).write(0, 3).write(f.frmsiz, 11).write(f.fscod, 2);
  if (f.fscod !== 3) w.write(f.numblkscod, 2);
  w.write(f.acmod, 3).write(f.lfeon, 1).write(f.bsid, 5);
  return w.bytes();
}

describe("dac3 — AC-3 description read from the bitstream", () => {
  it("describes a 5.1 track, where two mix-level fields sit between acmod and lfeon", () => {
    const payload = dac3(ac3Frame({ fscod: 0, frmsizecod: 38, bsid: 8, bsmod: 0, acmod: 7, lfeon: 1 }));
    const read = bits(payload.subarray(8));
    expect(read(2)).toBe(0); // fscod: 48 kHz
    expect(read(5)).toBe(8); // bsid
    expect(read(3)).toBe(0); // bsmod
    expect(read(3)).toBe(7); // acmod: 3/2
    expect(read(1)).toBe(1); // lfeon — only correct if both mix-level fields were skipped
    expect(read(5)).toBe(19); // bit rate code, frmsizecod >> 1
  });

  it("describes a stereo track, where a different conditional field is present instead", () => {
    // acmod 2 has no centre and no surround, so neither mix level is coded — but Dolby Surround
    // mode is. A parser that skipped the 5.1 fields here would read lfeon out of that field.
    const payload = dac3(ac3Frame({ fscod: 1, frmsizecod: 20, bsid: 8, bsmod: 2, acmod: 2, lfeon: 0 }));
    const read = bits(payload.subarray(8));
    expect(read(2)).toBe(1);
    expect(read(5)).toBe(8);
    expect(read(3)).toBe(2);
    expect(read(3)).toBe(2);
    expect(read(1)).toBe(0);
  });

  it("describes mono, which codes no conditional field at all", () => {
    const payload = dac3(ac3Frame({ fscod: 0, frmsizecod: 10, bsid: 8, bsmod: 0, acmod: 1, lfeon: 0 }));
    const read = bits(payload.subarray(8));
    read(2); read(5); read(3);
    expect(read(3)).toBe(1);
    expect(read(1)).toBe(0);
  });

  it("refuses bytes that are not a syncframe rather than describing noise", () => {
    expect(() => dac3(new Uint8Array(16))).toThrow(/synchronisation/);
  });
});

describe("dec3 — E-AC-3 description", () => {
  it("derives the data rate from the frame size and its duration", () => {
    // 640 kbit/s, 48 kHz, six blocks: 1536 samples in 2560 bytes.
    const payload = dec3(eac3Frame({ frmsiz: 1279, fscod: 0, numblkscod: 3, acmod: 7, lfeon: 1, bsid: 16 }));
    const read = bits(payload.subarray(8));
    expect(read(13)).toBe(640);
    expect(read(3)).toBe(0); // one independent substream
    expect(read(2)).toBe(0); // fscod
    expect(read(5)).toBe(16); // bsid
    read(1); read(1); read(3); // reserved, asvc, bsmod
    expect(read(3)).toBe(7); // acmod
    expect(read(1)).toBe(1); // lfeon
  });

  it("halves the rate when fscod selects the reduced sample rates", () => {
    // fscod 3 means the real rate is in fscod2 and the block count is fixed at six rather than
    // coded — reading a numblkscod field here would shift every field after it.
    const payload = dec3(eac3Frame({ frmsiz: 639, fscod: 3, numblkscod: 0, acmod: 2, lfeon: 0, bsid: 16 }));
    const read = bits(payload.subarray(8));
    expect(read(13)).toBe(160); // 1280 bytes over 1536 samples at 24 kHz
    read(3);
    expect(read(2)).toBe(3);
    expect(read(5)).toBe(16);
    read(1); read(1); read(3);
    expect(read(3)).toBe(2);
    expect(read(1)).toBe(0);
  });

  it("clamps a rate too large for its 13-bit field instead of corrupting the fields after it", () => {
    const payload = dec3(eac3Frame({ frmsiz: 2047, fscod: 0, numblkscod: 0, acmod: 7, lfeon: 1, bsid: 16 }));
    const read = bits(payload.subarray(8));
    expect(read(13)).toBeLessThanOrEqual(0x1fff);
    expect(read(3)).toBe(0);
  });
});

describe("sample entries", () => {
  it("carries the HEVC configuration through verbatim", () => {
    const codecPrivate = new Uint8Array([1, 2, 0x20, 0, 0, 0, 0x90, 0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f]);
    const entry = videoSampleEntry("V_MPEGH/ISO/HEVC", codecPrivate, 3840, 2160);
    expect(String.fromCharCode(...entry.subarray(4, 8))).toBe("hvc1");

    const view = new DataView(entry.buffer, entry.byteOffset);
    expect(view.getUint32(0)).toBe(entry.length);
    expect(view.getUint16(32)).toBe(3840);
    expect(view.getUint16(34)).toBe(2160);

    const hvcC = findBox(entry.subarray(8 + 78), "hvcC");
    expect(hvcC && Array.from(hvcC)).toEqual(Array.from(codecPrivate));
  });

  it("wraps an AAC configuration in the descriptor hierarchy, with a length that survives a big payload", () => {
    const config = new Uint8Array(200).fill(0x11);
    const entry = audioSampleEntryFor({
      codecId: "A_AAC", codecPrivate: config, channels: 6, sampleRate: 48000, firstFrame: null,
    });
    expect(String.fromCharCode(...entry.subarray(4, 8))).toBe("mp4a");

    const esds = findBox(entry.subarray(8 + 28), "esds");
    expect(esds).not.toBeNull();
    // The configuration must appear intact: a mis-encoded multi-byte descriptor length would
    // truncate it here, and a decoder would then be configured from a partial config.
    const haystack = Array.from(esds!).join(",");
    expect(haystack).toContain(Array.from(config).join(","));
  });

  it("names the codec box a player looks for, per codec", () => {
    const frame = ac3Frame({ fscod: 0, frmsizecod: 38, bsid: 8, bsmod: 0, acmod: 7, lfeon: 1 });
    const ac3 = audioSampleEntryFor({ codecId: "A_AC3", codecPrivate: null, channels: 6, sampleRate: 48000, firstFrame: frame });
    expect(String.fromCharCode(...ac3.subarray(4, 8))).toBe("ac-3");
    expect(findBox(ac3.subarray(8 + 28), "dac3")).not.toBeNull();

    const eac3Bytes = eac3Frame({ frmsiz: 1279, fscod: 0, numblkscod: 3, acmod: 7, lfeon: 1, bsid: 16 });
    const eac3 = audioSampleEntryFor({ codecId: "A_EAC3", codecPrivate: null, channels: 6, sampleRate: 48000, firstFrame: eac3Bytes });
    expect(String.fromCharCode(...eac3.subarray(4, 8))).toBe("ec-3");
    expect(findBox(eac3.subarray(8 + 28), "dec3")).not.toBeNull();
  });

  it("refuses a codec it cannot describe instead of emitting a broken entry", () => {
    expect(() => videoSampleEntry("V_VP9", new Uint8Array(4), 1920, 1080)).toThrow(/non remultiplexable/);
    expect(() =>
      audioSampleEntryFor({ codecId: "A_DTS", codecPrivate: null, channels: 6, sampleRate: 48000, firstFrame: null })
    ).toThrow(/non remultiplexable/);
    expect(() =>
      audioSampleEntryFor({ codecId: "A_AAC", codecPrivate: null, channels: 2, sampleRate: 48000, firstFrame: null })
    ).toThrow(/configuration/);
  });
});

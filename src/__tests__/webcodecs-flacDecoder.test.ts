import { describe, it, expect, vi } from "vitest";
import { streamInfoHeader } from "@/lib/webcodecs/flacHeader";
import { __testing } from "@/lib/webcodecs/ownAudio";
import type { RawFrame } from "@/lib/webcodecs/audioDemux";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

// A real FLAC stream made by ffmpeg: 2 048 frames of stereo, left held at +0.25 and right at
// −0.5 — two levels, so that a swap of the channels cannot pass. STREAMINFO alone as the header,
// as Matroska's CodecPrivate carries it, and one frame.
const STREAMINFO = hex(
  "664c6143800000220800080000000e00000e0bb802f000000800564a33e3c10ca7de21c2a462fadfb9cd"
);
const FRAME = hex("fff8ba18001801000901000785db");

/**
 * Notre ouvreur FLAC (ownAudio.ts, §197), branché comme `decodedFrom` le branche. Jusqu'au 19/11/2026
 * c'était un décodeur enregistré auprès de mediabunny (flacDecoder.ts) : mêmes trames, mêmes attentes.
 */
async function decoder(description: Uint8Array | ArrayBuffer | undefined) {
  const samples: RawFrame[] = [];
  const onError = vi.fn();
  const config = { codec: "flac", sampleRate: 48000, numberOfChannels: 2, ...(description ? { description } : {}) } as AudioDecoderConfig;
  const instance = await __testing.flacOpener(config)((frame) => samples.push(frame), onError);
  return { instance, samples, onError };
}
const packet = (data: Uint8Array, timestamp: number) => ({ data, timestamp, duration: 2048 / 48000 });

describe("décodeur FLAC (libFLAC)", () => {
  it("decodes a real frame to the exact samples, each channel in its place", async () => {
    // On 21/09/2026 Safari turned *Stand by Me*'s FLAC track away and the film went to the
    // server player. Before this decoder, nothing here could read FLAC at all.
    const { instance, samples } = await decoder(STREAMINFO);
    await instance.decode(packet(FRAME, 12.5));
    expect(samples).toHaveLength(1);
    const sample = samples[0];
    expect(sample.planes).toHaveLength(2);
    expect(sample.planes[0].length).toBe(2048);
    expect(sample.sampleRate).toBe(48000);
    // The packet's own time, not a count restarted at zero: after a seek that is all there is.
    expect(sample.timestamp).toBe(12.5);
    const [left, right] = sample.planes;
    // Within 1e-4, not exactly: the decoder scales 16-bit samples by 32 767 where ffmpeg uses
    // 32 768 — a gain of 0.0003 dB, which is why the real files matched ffmpeg to 0.01 dB.
    for (const value of left) expect(value).toBeCloseTo(0.25, 4);
    for (const value of right) expect(value).toBeCloseTo(-0.5, 4);
    instance.close();
  });

  it("reads the header from a bare buffer and from a view into a larger one alike", async () => {
    // A description may come either way (WebCodecs allows both). Told apart by ArrayBuffer.isView since TS 7's
    // typings (AllowSharedBufferSource): an offset view read from its start would hand libFLAC the
    // bytes before the header.
    const padded = new Uint8Array(STREAMINFO.length + 7);
    padded.set(STREAMINFO, 5);
    for (const description of [STREAMINFO.slice().buffer, padded.subarray(5, 5 + STREAMINFO.length)]) {
      const { instance, samples } = await decoder(description as never);
      await instance.decode(packet(FRAME, 0));
      expect(samples).toHaveLength(1);
      for (const value of samples[0].planes[0]) expect(value).toBeCloseTo(0.25, 4);
      instance.close();
    }
  });

  it("is given STREAMINFO and nothing else of the header, and still decodes", async () => {
    // *Le Retour de Martin Guerre* (21/09/2026): 8 KiB of PADDING after STREAMINFO in its
    // CodecPrivate made libFLAC corrupt its heap 25 s in. A header carrying padding and tags must
    // reach it as STREAMINFO alone — and the frame must still come out exact.
    const tags = hex("0400000800000000" + "00000000"); // VORBIS_COMMENT, empty vendor, no field
    const padding = new Uint8Array(4 + 8192);
    padding[0] = 0x81; // PADDING, last block
    padding.set([0x00, 0x20, 0x00], 1);
    const streaminfo = STREAMINFO.slice();
    streaminfo[4] &= 0x7f; // no longer the last block
    const header = new Uint8Array([...streaminfo, ...tags, ...padding]);
    const { instance, samples } = await decoder(header);
    await instance.decode(packet(FRAME, 0));
    expect(samples).toHaveLength(1);
    for (const value of samples[0].planes[0]) expect(value).toBeCloseTo(0.25, 4);
    instance.close();
  });
});

describe("streamInfoHeader", () => {
  it("keeps the magic and STREAMINFO, marked as the last block", () => {
    const streaminfo = STREAMINFO.slice();
    streaminfo[4] &= 0x7f;
    const padding = new Uint8Array(4 + 16);
    padding[0] = 0x81;
    padding[3] = 16;
    const out = streamInfoHeader(new Uint8Array([...streaminfo, ...padding]));
    expect(out.length).toBe(4 + 4 + 34);
    expect(Array.from(out)).toEqual(Array.from(STREAMINFO)); // STREAMINFO already carries the flag
  });

  it("adds the magic when Matroska left it out", () => {
    expect(Array.from(streamInfoHeader(STREAMINFO.subarray(4)))).toEqual(Array.from(STREAMINFO));
  });

  it("passes a header that does not open on STREAMINFO as it came", () => {
    const odd = hex("664c61430100000400000000");
    expect(Array.from(streamInfoHeader(odd))).toEqual(Array.from(odd));
    const cut = STREAMINFO.subarray(0, 20);
    expect(Array.from(streamInfoHeader(cut))).toEqual(Array.from(cut));
  });
});

/**
 * Une trame illisible est signalée, pas levée : `decodedFrom` la remonte au transcodeur, qui passe la
 * main (relevé le 23/09/2026 : une promesse rejetée chez mediabunny arrêtait le son sans message).
 */
describe("décodeur FLAC — trame refusée", () => {
  it("prévient par onError au lieu de rejeter", async () => {
    const { instance, onError } = await decoder(STREAMINFO);
    await expect(instance.decode(packet(new Uint8Array([0xff, 0xf8, 0, 0, 0, 0]), 0))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
    instance.close();
  });
});

import { describe, it, expect } from "vitest";
import type { AudioSample } from "mediabunny";
import { __testing } from "@/lib/webcodecs/flacDecoder";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

// A real FLAC stream made by ffmpeg: 2 048 frames of stereo, left held at +0.25 and right at
// −0.5 — two levels, so that a swap of the channels cannot pass. STREAMINFO alone as the header,
// as Matroska's CodecPrivate carries it, and one frame.
const STREAMINFO = hex(
  "664c6143800000220800080000000e00000e0bb802f000000800564a33e3c10ca7de21c2a462fadfb9cd"
);
const FRAME = hex("fff8ba18001801000901000785db");

/** Wired the way mediabunny wires a registered decoder (media-sink.js). */
async function decoder(description: Uint8Array | undefined) {
  const samples: AudioSample[] = [];
  const instance = new __testing.FlacDecoder();
  Object.assign(instance, {
    codec: "flac",
    config: { codec: "flac", sampleRate: 48000, numberOfChannels: 2, description },
    onSample: (sample: AudioSample) => samples.push(sample),
  });
  await instance.init();
  return { instance, samples };
}

describe("FlacDecoder", () => {
  it("claims FLAC and nothing else", () => {
    expect(__testing.FlacDecoder.supports("flac")).toBe(true);
    expect(__testing.FlacDecoder.supports("dts")).toBe(false);
  });

  it("decodes a real frame to the exact samples, each channel in its place", async () => {
    // On 21/09/2026 Safari turned *Stand by Me*'s FLAC track away and the film went to the
    // server player. Before this decoder, nothing here could read FLAC at all.
    const { instance, samples } = await decoder(STREAMINFO);
    await instance.decode({ data: FRAME, timestamp: 12.5 } as never);
    expect(samples).toHaveLength(1);
    const sample = samples[0];
    expect(sample.numberOfChannels).toBe(2);
    expect(sample.numberOfFrames).toBe(2048);
    expect(sample.sampleRate).toBe(48000);
    // The packet's own time, not a count restarted at zero: after a seek that is all there is.
    expect(sample.timestamp).toBe(12.5);
    const left = new Float32Array(2048);
    const right = new Float32Array(2048);
    sample.copyTo(left, { planeIndex: 0, format: "f32-planar" });
    sample.copyTo(right, { planeIndex: 1, format: "f32-planar" });
    // Within 1e-4, not exactly: the decoder scales 16-bit samples by 32 767 where ffmpeg uses
    // 32 768 — a gain of 0.0003 dB, which is why the real files matched ffmpeg to 0.01 dB.
    for (const value of left) expect(value).toBeCloseTo(0.25, 4);
    for (const value of right) expect(value).toBeCloseTo(-0.5, 4);
    await instance.close();
  });
});

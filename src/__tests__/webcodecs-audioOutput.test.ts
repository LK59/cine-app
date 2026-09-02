// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AudioOutput } from "@/lib/webcodecs/audioOutput";

// A decoded block, in whichever layout a decoder chose. The real AudioData is a browser type;
// what matters here is that copyTo hands back the bytes in the format it was asked for — and
// crucially that it is only ever asked for the format the block already has, since a browser
// that cannot convert throws, inside a callback where the exception vanishes.
function fakeAudioData(format: string, channels: number, frames: number, fill: (channel: number, index: number) => number) {
  const bytesPer = format.startsWith("f32") || format.startsWith("s32") ? 4 : format.startsWith("s16") ? 2 : 1;
  const planar = format.endsWith("-planar");
  return {
    format,
    numberOfChannels: channels,
    numberOfFrames: frames,
    sampleRate: 48000,
    timestamp: 0,
    duration: (frames / 48000) * 1e6,
    allocationSize: ({ planeIndex, format: asked }: { planeIndex: number; format: string }) => {
      if (asked !== format) throw new Error(`conversion refusée: ${format} -> ${asked}`);
      if (planar && planeIndex >= channels) throw new Error("plan inexistant");
      return (planar ? frames : frames * channels) * bytesPer;
    },
    copyTo: (destination: ArrayBufferView, { planeIndex, format: asked }: { planeIndex: number; format: string }) => {
      if (asked !== format) throw new Error(`conversion refusée: ${format} -> ${asked}`);
      const buffer = destination.buffer as ArrayBuffer;
      const write = (index: number, value: number) => {
        if (format.startsWith("f32")) new Float32Array(buffer)[index] = value;
        else if (format.startsWith("s16")) new Int16Array(buffer)[index] = value;
        else if (format.startsWith("s32")) new Int32Array(buffer)[index] = value;
        else new Uint8Array(buffer)[index] = value;
      };
      if (planar) for (let i = 0; i < frames; i++) write(i, fill(planeIndex, i));
      else for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) write(i * channels + c, fill(c, i));
    },
    close: () => {},
  } as unknown as AudioData;
}

const channelData: number[][] = [];

beforeEach(() => {
  channelData.length = 0;
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      state = "running";
      sampleRate = 48000;
      destination = {};
      createGain() {
        return { gain: { setTargetAtTime: vi.fn() }, connect: vi.fn() };
      }
      createBuffer(channels: number, frames: number) {
        return {
          duration: frames / 48000,
          copyToChannel: (data: Float32Array, channel: number) => {
            channelData[channel] = Array.from(data);
          },
        };
      }
      createBufferSource() {
        return { buffer: null, connect: vi.fn(), start: vi.fn(), onended: null };
      }
      resume() {
        return Promise.resolve();
      }
      suspend() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
  );
});

describe("AudioOutput channel extraction", () => {
  it("reads planar float, the common case, channel by channel", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 2 });
    // channel 0 = 0.5s, channel 1 = -0.5s, so a swap would be obvious.
    expect(output.enqueue(fakeAudioData("f32-planar", 2, 4, (c) => (c === 0 ? 0.5 : -0.5)), 0)).toBe(true);
    expect(channelData[0]).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(channelData[1]).toEqual([-0.5, -0.5, -0.5, -0.5]);
  });

  it("de-interleaves an interleaved block instead of asking for a conversion", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 2 });
    expect(output.enqueue(fakeAudioData("f32", 2, 3, (c, i) => c + i / 10), 0)).toBe(true);
    expect(channelData[0]).toEqual([0, 0.1, 0.2].map((v) => Math.fround(v)));
    expect(channelData[1]).toEqual([1, 1.1, 1.2].map((v) => Math.fround(v)));
  });

  it("scales integer formats to the -1..1 range", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 1 });
    output.enqueue(fakeAudioData("s16-planar", 1, 2, () => 16384), 0);
    expect(channelData[0]).toEqual([0.5, 0.5]);

    channelData.length = 0;
    output.enqueue(fakeAudioData("s32", 1, 2, () => 1073741824), 0);
    expect(channelData[0]).toEqual([0.5, 0.5]);

    channelData.length = 0;
    output.enqueue(fakeAudioData("u8-planar", 1, 2, () => 192), 0);
    expect(channelData[0]).toEqual([0.5, 0.5]);
  });

  // The failure this whole rewrite exists for: inside a decoder's output callback a thrown
  // exception is swallowed by the browser, so silence was the only symptom.
  it("reports a failure instead of throwing into nowhere", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 2 });
    const reasons: string[] = [];
    output.onError = (reason) => reasons.push(reason);

    const hostile = fakeAudioData("f32-planar", 2, 4, () => 0);
    (hostile as unknown as { copyTo: () => void }).copyTo = () => {
      throw new Error("copyTo indisponible");
    };

    expect(output.enqueue(hostile, 0)).toBe(false);
    expect(reasons).toEqual(["copyTo indisponible"]);
  });
});

describe("multichannel fold", () => {
  // Every file in this library is 5.1, and every one of them was silent while the diagnostics
  // showed a running context, hundreds of decoded blocks and a full buffer. A multichannel
  // AudioBuffer a browser declines to downmix fails exactly that way, so the fold happens here.
  it("hands the audio graph two channels, never six", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 6 });
    output.enqueue(fakeAudioData("f32-planar", 6, 2, () => 0.1), 0);
    expect(channelData).toHaveLength(2);
  });

  it("keeps the fronts, folds the centre into both sides and each surround into its own", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 6 });
    // FL=1, FR=0, C=0, LFE=0, SL=0, SR=0 — only the front left should carry signal.
    output.enqueue(fakeAudioData("f32-planar", 6, 1, (c) => (c === 0 ? 1 : 0)), 0);
    expect(channelData[0][0]).toBeCloseTo(0.8, 5);
    expect(channelData[1][0]).toBeCloseTo(0, 5);

    channelData.length = 0;
    // Centre only: equal in both, at half power.
    output.enqueue(fakeAudioData("f32-planar", 6, 1, (c) => (c === 2 ? 1 : 0)), 0);
    expect(channelData[0][0]).toBeCloseTo(Math.SQRT1_2 * 0.8, 5);
    expect(channelData[1][0]).toBeCloseTo(Math.SQRT1_2 * 0.8, 5);

    channelData.length = 0;
    // Left surround only: left side alone.
    output.enqueue(fakeAudioData("f32-planar", 6, 1, (c) => (c === 4 ? 1 : 0)), 0);
    expect(channelData[0][0]).toBeCloseTo(Math.SQRT1_2 * 0.8, 5);
    expect(channelData[1][0]).toBeCloseTo(0, 5);
  });

  it("drops the LFE, which a stereo fold has nowhere to put", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 6 });
    output.enqueue(fakeAudioData("f32-planar", 6, 1, (c) => (c === 3 ? 1 : 0)), 0);
    expect(channelData[0][0]).toBeCloseTo(0, 5);
    expect(channelData[1][0]).toBeCloseTo(0, 5);
  });

  it("never clips, however loud the mix", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 6 });
    output.enqueue(fakeAudioData("f32-planar", 6, 1, () => 1), 0);
    for (const channel of channelData) expect(Math.abs(channel[0])).toBeLessThanOrEqual(1);
  });

  it("leaves stereo and mono alone", () => {
    const output = new AudioOutput({ sampleRate: 48000, numberOfChannels: 2 });
    output.enqueue(fakeAudioData("f32-planar", 2, 1, (c) => (c === 0 ? 1 : -1)), 0);
    expect(channelData[0][0]).toBe(1);
    expect(channelData[1][0]).toBe(-1);
  });
});

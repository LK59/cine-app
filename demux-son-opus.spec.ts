// Enquête demux-son : l'horloge du décodé Opus, chemin actuel contre essai, avec un AudioDecoder factice
// (chaque paquet rend 960 images à l'instant du paquet, comme un vrai décodeur Opus à 48 kHz).
import { it } from "vitest";
import { openSync, readSync, statSync, readFileSync } from "node:fs";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
function src(path: string): ByteSource { const fd = openSync(path, "r"); const size = statSync(path).size; return { size, read: async (s: number, l: number) => { const n = Math.max(0, Math.min(l, size - s)); const b = Buffer.alloc(n); readSync(fd, b, 0, n, s); return new Uint8Array(b); }, close: () => {} }; }
class FakeAudioData {
  format = "f32-planar"; numberOfChannels = 2; sampleRate = 48000; numberOfFrames = 960; duration = 20000;
  constructor(public timestamp: number) {}
  allocationSize() { return 960 * 4; }
  copyTo(dest: Float32Array) { dest.fill(0); }
  clone() { return new FakeAudioData(this.timestamp); }
  close() {}
}
class FakeAudioDecoder extends EventTarget {
  static async isConfigSupported(config: unknown) { return { supported: true, config }; }
  decodeQueueSize = 0; state = "unconfigured";
  constructor(private init: { output: (d: unknown) => void }) { super(); }
  configure() { this.state = "configured"; }
  decode(chunk: { timestamp: number }) { const ts = chunk.timestamp; queueMicrotask(() => this.init.output(new FakeAudioData(ts))); }
  async flush() { await new Promise((r) => setTimeout(r, 0)); }
  close() { this.state = "closed"; }
}
(globalThis as Record<string, unknown>).AudioData = FakeAudioData;
(globalThis as Record<string, unknown>).AudioDecoder = FakeAudioDecoder;
(globalThis as Record<string, unknown>).EncodedAudioChunk = class { timestamp: number; constructor(i: { timestamp: number }) { this.timestamp = i.timestamp; } };
it.skipIf(!process.env.OP_TRACK)("horloge opus", async () => {
  const [path, n, , from] = readFileSync(process.env.OP_TRACK!, "utf8").trim().split("\t");
  const s = src(path); const file = await openMediaFile(s);
  for (const demux of [undefined, "nôtre"] as const) {
    const track = await SoftwareAudioTrack.open(s, Number(n), "A_OPUS", file, demux ? { demux } : {});
    let prevEnd: number | null = null; let overlaps = 0; let gaps = 0; let frames = 0; let worst = 0; const t0 = Number(from);
    for await (const d of track.samples(t0)) {
      if (d.timestampSeconds >= t0 + 30) break;
      const len = d.planes[0].length / d.sampleRate;
      if (prevEnd !== null) { const delta = d.timestampSeconds - prevEnd; if (delta < -0.001) { overlaps++; worst = Math.min(worst, delta); } if (delta > 0.001) gaps++; }
      prevEnd = d.timestampSeconds + len; frames++;
    }
    console.log("RESULT", demux ?? "mediabunny", "trames", frames, "chevauchements", overlaps, "trous", gaps, "pire recul ms", Math.round(worst * 1000));
  }
}, 600000);

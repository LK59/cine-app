// Banc du son en retard sur l'image (DECISIONS.md §148) — sauté sans GAP_FILES.
//
// Pour chaque fichier (un chemin par ligne dans GAP_FILES) et chaque piste audio, ouvre le
// remultiplexeur comme le lecteur (livraison par piste) à 0 s et à GAP_AT (« 10,600 » par défaut :
// dans le trou d'un fichier à trou, et loin dedans le film), puis écrit dans GAP_OUT une ligne
// JSON : la décision (type MIME du son, copié ou ré-encodé, ce que `audioLeadGap` dit), l'empreinte
// du segment d'initialisation audio et des octets audio des GAP_SEGMENTS premiers segments
// (8 par défaut), et le premier instant de l'image et du son livrés (`tfdt` des fragments).
// Lancé sur le code d'avant et d'après, un fichier sans trou doit donner des lignes identiques.
//
// L'encodeur est factice et déterministe (Node n'en a pas) : chaque trame porte l'empreinte des
// échantillons reçus — deux sorties identiques, deux entrées identiques. GAP_PCM_DIR, s'il est
// donné, reçoit pour chaque ouverture ré-encodée le PCM donné à l'encodeur (f32 entrelacé, avec son
// premier instant et ses canaux dans le nom), à comparer au décodage d'ffmpeg du même fichier ; et
// GAP_MP4_DIR les segments audio et vidéo livrés, que `ffprobe -show_packets` relit.
//
// GAP_REFUSE : les codecs que le navigateur simulé refuse dans MediaSource (expression régulière,
// rien par défaut : un iPhone, qui copie AC-3, E-AC-3 et AAC). « ac-3|ec-3 » : Chrome.
//
//   docker run --rm --name lumen-trou-banc -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e GAP_FILES=/app/gap-files.txt -e GAP_OUT=/app/gap-out.jsonl node:26-alpine \
//     npx vitest run audio-gap-bench.spec.ts
import { describe, it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import { fragmentTimes } from "@/lib/webcodecs/fragmentProbe";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

const REFUSED = process.env.GAP_REFUSE ? new RegExp(process.env.GAP_REFUSE, "i") : null;
const anySource = { isTypeSupported: (mime: string) => !REFUSED?.test(mime) };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

class FakeAudioData {
  constructor(readonly init: { numberOfFrames: number; numberOfChannels: number; sampleRate: number; timestamp: number; data: Float32Array }) {}
  close() {}
}

/** Le PCM donné à l'encodeur courant, gardé pour GAP_PCM_DIR. */
type Fed = { timestamp: number; channels: number; rate: number; chunks: Float32Array[] };
let fed: Fed | null = null;
/** Lu par une fonction : l'encodeur le remplit pendant les `await`, ce que TypeScript ne voit pas. */
const currentFed = (): Fed | null => fed;

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function ascFor(sampleRate: number, channels: number): Uint8Array {
  const index = Math.max(0, SAMPLE_RATES.indexOf(sampleRate));
  const config = channels === 8 ? 7 : Math.min(channels, 6);
  return new Uint8Array([(2 << 3) | (index >> 1), ((index & 1) << 7) | (config << 3)]);
}

/** Le même que `mediabunny-regress-bench.spec.ts` : trames de 1024 images, chacune l'empreinte de ce qu'il a reçu. */
class FakeAudioEncoder {
  static async isConfigSupported(config: unknown) {
    return { supported: true, config };
  }
  state = "unconfigured";
  encodeQueueSize = 0;
  private hash: Hash = createHash("sha256");
  private held = 0;
  private heldFrom = 0;
  private described = false;
  private config = { sampleRate: 48000, numberOfChannels: 2 };
  constructor(private readonly init: { output: (c: unknown, m?: unknown) => void; error: (e: unknown) => void }) {}
  configure(config: { sampleRate: number; numberOfChannels: number }) {
    this.config = config;
    this.state = "configured";
    fed = null;
  }
  encode(data: FakeAudioData) {
    const { data: floats, numberOfFrames, timestamp, sampleRate, numberOfChannels } = data.init;
    this.hash.update(new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength));
    this.hash.update(`|${numberOfFrames}@${timestamp}|`);
    fed ??= { timestamp, channels: numberOfChannels, rate: sampleRate, chunks: [] };
    fed.chunks.push(floats.slice());
    const frameUs = Math.round((1024 / sampleRate) * 1e6);
    if (this.held === 0) this.heldFrom = timestamp;
    this.held += numberOfFrames;
    while (this.held >= 1024) {
      this.emit(this.heldFrom, frameUs);
      this.heldFrom += frameUs;
      this.held -= 1024;
    }
  }
  private emit(timestamp: number, duration: number) {
    const bytes = this.hash.copy().digest().subarray(0, 16);
    const metadata = this.described ? undefined : { decoderConfig: { description: ascFor(this.config.sampleRate, this.config.numberOfChannels) } };
    this.described = true;
    this.init.output({ type: "key", timestamp, duration, byteLength: bytes.byteLength, copyTo: (d: Uint8Array) => d.set(bytes) }, metadata);
  }
  async flush() {
    if (this.held > 0) {
      this.emit(this.heldFrom, Math.round((1024 / this.config.sampleRate) * 1e6));
      this.held = 0;
    }
  }
  reset() {
    this.held = 0;
  }
  close() {
    this.state = "closed";
  }
}
(globalThis as unknown as { AudioData: unknown }).AudioData = FakeAudioData;
(globalThis as unknown as { AudioEncoder: unknown }).AudioEncoder = FakeAudioEncoder;

function fileSource(path: string): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    read: async (start: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - start));
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      return new Uint8Array(buffer.subarray(0, read));
    },
    close: () => closeSync(fd),
  };
}

const sha = (b: Uint8Array | null | undefined) => (b ? createHash("sha256").update(b).digest("hex").slice(0, 16) : null);
const round = (n: number) => Math.round(n * 1000) / 1000;

describe.skipIf(!process.env.GAP_FILES)("son en retard sur l'image", () => {
  it("ouvre, décide et livre", { timeout: 3_600_000 }, async () => {
    const files = readFileSync(process.env.GAP_FILES!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const starts = [0, ...(process.env.GAP_AT ?? "10,600").split(",").map(Number)];
    const segments = Number(process.env.GAP_SEGMENTS ?? 8);
    for (const path of files) {
      const source = fileSource(path);
      try {
        const file = await openMediaFile(source);
        const video = file.tracks.find((t) => t.type === "video");
        if (!video) continue;
        for (const audio of file.tracks.filter((t) => t.type === "audio")) {
          for (const at of starts) {
            const name = path.split("/").pop()!;
            const row: Record<string, unknown> = { file: name, track: audio.number, codec: audio.codecId, at };
            try {
              fed = null;
              const remuxer = await Remuxer.open(source, file, video, audio, { width: 1920, height: 1080 }, null, at, { perTrack: true });
              const plan = remuxer.plan();
              row.mime = plan.audioMimeType;
              row.transcoded = remuxer.diagnostics().transcodedAudio;
              const gap = (remuxer as unknown as { audioLeadGap?: () => unknown }).audioLeadGap?.();
              if (gap) row.leadGap = gap;
              row.init = sha(plan.audioInit);
              if (at > 0) remuxer.seekTo(at);
              const hash = createHash("sha256");
              let bytes = 0;
              let end = 0;
              let firstVideo: number | null = null;
              let firstAudio: number | null = null;
              const videoOut: Uint8Array[] = [plan.videoInit];
              const audioOut: Uint8Array[] = plan.audioInit ? [plan.audioInit] : [];
              for (let i = 0; i < segments; i++) {
                const segment = await remuxer.nextSegment();
                if (!segment) break;
                for (const fragment of segment.video) {
                  firstVideo ??= fragmentTimes(fragment)?.pts ?? null;
                  videoOut.push(fragment);
                }
                if (segment.audio) {
                  firstAudio ??= fragmentTimes(segment.audio)?.dts ?? null;
                  hash.update(segment.audio);
                  bytes += segment.audio.byteLength;
                  audioOut.push(segment.audio);
                }
                end = segment.endSeconds;
              }
              row.audioHash = hash.digest("hex").slice(0, 16);
              row.audioBytes = bytes;
              row.endSeconds = round(end);
              row.firstVideoS = firstVideo === null ? null : round(firstVideo);
              row.firstAudioS = firstAudio === null ? null : round(firstAudio);
              row.delayS = round(remuxer.diagnostics().presentationDelaySeconds);
              const tag = `${name.replace(/[^\w]+/g, "_")}-t${audio.number}-at${at}`;
              if (process.env.GAP_MP4_DIR) {
                mkdirSync(process.env.GAP_MP4_DIR, { recursive: true });
                writeFileSync(`${process.env.GAP_MP4_DIR}/${tag}-video.mp4`, Buffer.concat(videoOut));
                if (audioOut.length > 0) writeFileSync(`${process.env.GAP_MP4_DIR}/${tag}-audio.mp4`, Buffer.concat(audioOut));
              }
              const pcm = currentFed();
              if (process.env.GAP_PCM_DIR && pcm) {
                mkdirSync(process.env.GAP_PCM_DIR, { recursive: true });
                const all = Buffer.concat(pcm.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
                writeFileSync(`${process.env.GAP_PCM_DIR}/${tag}-from${pcm.timestamp}us-${pcm.channels}ch-${pcm.rate}.f32`, all);
              }
              remuxer.close();
            } catch (e) {
              row.error = String(e instanceof Error ? e.message : e).slice(0, 200);
            }
            appendFileSync(process.env.GAP_OUT!, JSON.stringify(row) + "\n");
          }
        }
      } finally {
        source.close();
      }
    }
  });
});

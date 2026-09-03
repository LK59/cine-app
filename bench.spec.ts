// Verification bench for the remuxer, run against real files.
//
// The remuxer is pure TypeScript over a ByteSource, so a file-backed source is all it takes to
// run the whole thing outside a browser. What it produces is written out for ffmpeg to decode and
// for ffprobe to be compared against — the method that found every bug the synthetic tests missed.

import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { parseMatroska } from "@/lib/webcodecs/matroska";
import { Remuxer, setAudioBufferRebuildable } from "@/lib/webcodecs/remuxer";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

// The remuxer asks the browser what it will accept. Here it accepts everything, so every track
// rides through untouched and no encoder is needed.
// `sourceConstructor` reads window.ManagedMediaSource first and falls back to the *global*
// MediaSource, not window's — so stubbing only the latter left it with nothing to ask.
const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

function fileSource(path: string): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    // ByteSource asks for a length, not an end offset. Reading it as an end offset returns
    // nothing for every offset past the first, which reads exactly like a corrupt file.
    read: async (start: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - start));
      // Allocated, not taken from the pool, and copied out. Node hands small allocUnsafe
      // buffers slices of one shared pool, so a view returned from here was overwritten by the
      // next read — and a parser holding on to earlier bytes saw them change under it.
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

const path = process.env.BENCH_FILE!;
const from = Number(process.env.BENCH_FROM ?? 0);
const count = Number(process.env.BENCH_COUNT ?? 8);
const outPath = process.env.BENCH_OUT!;

import { describe, it } from "vitest";

// Kept in the repository because it is the only thing that ever found the bugs synthetic tests
// could not, and skipped unless asked for: it needs a real file and writes real output.
//
//   docker run --rm -v "$PWD":/app -v /tmp/bench:/bench -v /mnt/media/video:/media:ro -w /app \
//     -e BENCH_FILE="/media/tv/…mkv" -e BENCH_FROM=1951 -e BENCH_COUNT=6 -e BENCH_OUT=/bench/out \
//     node:24-alpine sh -c "npx vitest run bench.spec.ts"
//
// Then, on a machine with ffmpeg: decode `<out>.video.mp4` expecting no errors, and compare the
// sequence of gaps between presentation timestamps against ffprobe's reading of the source over
// the same span. The gaps are what matters — they are invariant under the presentation delay,
// where a timestamp-by-timestamp comparison silently absorbs it and measures nothing.
describe.skipIf(!process.env.BENCH_FILE)("banc", () => {
  it("remultiplexe un vrai fichier", { timeout: 600_000 }, async () => {
    // Unification would re-encode every track on a file that mixes codecs, and there is no
    // AudioEncoder here. Off, so the copied path — the one whose bytes are being checked — runs.
    setAudioBufferRebuildable(true);
    const source = fileSource(path);
    const file = await parseMatroska(source);
    const video = file.tracks.find((t) => t.type === "video")!;
    // A track that rides through untouched: no AudioEncoder exists here.
    const audio = file.tracks.filter((t) => t.type === "audio").find((t) => t.codecId !== "A_DTS") ?? null;
    
    console.log(`pistes : ${file.tracks.map((t) => `${t.number}:${t.type}:${t.codecId}`).join(" ")}`);
    console.log(`vidéo ${video.codecId} ${video.video?.width}×${video.video?.height}, audio ${audio?.codecId ?? "aucune"}`);
    
    const remuxer = await Remuxer.open(source, file, video, audio, {
      width: video.video?.width ?? 1920,
      height: video.video?.height ?? 1080,
    });
    const plan = remuxer.plan();
    console.log(`plan : ${plan.videoMimeType} + ${plan.audioMimeType}`);
    
    if (from > 0) remuxer.seekTo(from);
    
    const parts: Uint8Array[] = [plan.videoInit];
    const audioParts: Uint8Array[] = plan.audioInit ? [plan.audioInit] : [];
    const sizes: { index: number; endSeconds: number; videoBytes: number; audioBytes: number; fragments: number }[] = [];
    
    for (let i = 0; i < count; i++) {
      const segment = await remuxer.nextSegment();
      if (!segment) break;
      const fragments: Uint8Array[] = segment.video;
      for (const fragment of fragments) parts.push(fragment);
      if (segment.audio) audioParts.push(segment.audio);
      sizes.push({
        index: i + 1,
        endSeconds: segment.endSeconds,
        videoBytes: fragments.reduce((n, f) => n + f.byteLength, 0),
        audioBytes: segment.audio?.byteLength ?? 0,
        fragments: fragments.length,
      });
    }
    
    const join = (chunks: Uint8Array[]) => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out;
    };
    
    writeFileSync(`${outPath}.video.mp4`, join(parts));
    if (audioParts.length > 1) writeFileSync(`${outPath}.audio.mp4`, join(audioParts));
    writeFileSync(
      `${outPath}.json`,
      JSON.stringify({ diagnostics: remuxer.diagnostics(), segments: sizes }, null, 2)
    );
    
    console.log("");
    for (const s of sizes) {
      console.log(
        `segment ${s.index} : jusqu'à ${s.endSeconds.toFixed(2)} s, ` +
          `${s.videoBytes} o vidéo en ${s.fragments} fragment(s), ${s.audioBytes} o audio`
      );
    }
    const biggest = Math.max(...parts.slice(1).map((p) => p.byteLength));
    console.log(`\nplus gros envoi vidéo : ${biggest} octets`);
    console.log(`diagnostics : ${JSON.stringify(remuxer.diagnostics())}`);
    remuxer.close();
    source.close();
    
  });
});

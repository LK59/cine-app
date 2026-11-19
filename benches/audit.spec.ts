import { describe, it } from "vitest";
import { openSync, readSync, closeSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMatroska, clusterOffsetForTime } from "@/lib/webcodecs/matroska";
import { SampleReader } from "@/lib/webcodecs/sampleReader";
import { isRandomAccessPoint, nalLengthSize, hevcCodecString, avcCodecString } from "@/lib/webcodecs/codecConfig";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

// Walks the library and asks of every file the questions the player asks of one. Not part of the
// suite: it reads hundreds of gigabytes and reports rather than asserting.
//
//   BENCH_ROOT=/media BENCH_LIMIT=400 npx vitest run audit.spec.ts

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

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.toLowerCase().endsWith(".mkv")) yield path;
  }
}

interface Row {
  path: string;
  video: string;
  codecString: string | null;
  audio: string[];
  keys: number;
  raps: number;
  worstGap: number;
  error?: string;
}

describe.skipIf(!process.env.BENCH_ROOT)("audit", () => {
  it("interroge la bibliothèque", { timeout: 3_600_000 }, async () => {
    const root = process.env.BENCH_ROOT!;
    const limit = Number(process.env.BENCH_LIMIT ?? 1000);
    const at = Number(process.env.BENCH_AT ?? 600);
    const span = Number(process.env.BENCH_SPAN ?? 90);

    const files = [...walk(root)].slice(0, limit);
    console.log(`${files.length} fichiers`);
    const rows: Row[] = [];

    for (const path of files) {
      const source = fileSource(path);
      try {
        const file = await parseMatroska(source);
        const video = file.tracks.find((t) => t.type === "video");
        if (!video) throw new Error("aucune piste vidéo");
        const codecString =
          video.codecId === "V_MPEGH/ISO/HEVC" && video.codecPrivate
            ? hevcCodecString(video.codecPrivate)
            : video.codecId === "V_MPEG4/ISO/AVC" && video.codecPrivate
              ? avcCodecString(video.codecPrivate)
              : null;

        const row: Row = {
          path,
          video: video.codecId,
          codecString,
          audio: file.tracks.filter((t) => t.type === "audio").map((t) => t.codecId),
          keys: 0,
          raps: 0,
          worstGap: 0,
        };

        // A stretch in the middle, which is representative and avoids opening credits.
        const size = nalLengthSize(video.codecId, video.codecPrivate);
        const from = Math.min(at, (file.durationSeconds ?? 0) * 0.5);
        const offset = clusterOffsetForTime(file, from * 1e6, video.number) ?? file.segmentDataStart;
        const reader = new SampleReader(source, file, offset);
        let lastRap: number | null = null;
        for (let i = 0; i < 100_000; i++) {
          const sample = await reader.next();
          if (!sample) break;
          if (sample.trackNumber !== video.number) continue;
          const seconds = sample.timestampUs / 1e6;
          if (seconds > from + span) break;
          if (!sample.isKey) continue;
          row.keys += 1;
          if (isRandomAccessPoint(sample.data, video.codecId, size)) {
            row.raps += 1;
            if (lastRap !== null) row.worstGap = Math.max(row.worstGap, seconds - lastRap);
            lastRap = seconds;
          }
        }
        rows.push(row);
      } catch (error) {
        rows.push({
          path,
          video: "?",
          codecString: null,
          audio: [],
          keys: 0,
          raps: 0,
          worstGap: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        source.close();
      }
      if (rows.length % 25 === 0) console.log(`  ${rows.length}/${files.length}…`);
    }

    writeFileSync(process.env.BENCH_OUT ?? "/bench/audit.json", JSON.stringify(rows, null, 1));
    console.log(`écrit : ${rows.length} lignes`);
  });
});

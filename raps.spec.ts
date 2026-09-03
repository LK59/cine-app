import { describe, it } from "vitest";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { parseMatroska, clusterOffsetForTime } from "@/lib/webcodecs/matroska";
import { SampleReader } from "@/lib/webcodecs/sampleReader";
import { isRandomAccessPoint, nalLengthSize } from "@/lib/webcodecs/codecConfig";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

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

describe.skipIf(!process.env.BENCH_FILE)("points d'accès", () => {
  it("mesure ce qu'un saut coûte", { timeout: 600_000 }, async () => {
    const source = fileSource(process.env.BENCH_FILE!);
    const file = await parseMatroska(source);
    const video = file.tracks.find((t) => t.type === "video")!;
    const size = nalLengthSize(video.codecId, video.codecPrivate);
    const from = Number(process.env.BENCH_FROM ?? 0);
    const span = Number(process.env.BENCH_SPAN ?? 300);
    const offset = clusterOffsetForTime(file, from * 1_000_000, video.number) ?? file.segmentDataStart;
    const reader = new SampleReader(source, file, offset);

    const keys: number[] = [];
    const raps: number[] = [];
    for (let i = 0; i < 200_000; i++) {
      const sample = await reader.next();
      if (!sample) break;
      if (sample.trackNumber !== video.number) continue;
      const at = sample.timestampUs / 1_000_000;
      if (at > from + span) break;
      if (!sample.isKey) continue;
      keys.push(at);
      if (isRandomAccessPoint(sample.data, video.codecId, size)) raps.push(at);
    }
    const gaps = raps.slice(1).map((t, i) => t - raps[i]);
    // The cost of this change, and nothing else: for a target every second, how much further
    // the next *usable* start sits than the next one the container claimed. Zero wherever the
    // container was telling the truth, which is most files and most of every file.
    const added: number[] = [];
    for (let t = raps[0]; t < raps[raps.length - 1]; t += 1) {
      added.push(raps.find((r) => r >= t)! - keys.find((k) => k >= t)!);
    }
    const late = added;
    const hurt = added.filter((x) => x > 0.001);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(
      `${keys.length} images-clés annoncées, ${raps.length} vraies (${keys.length - raps.length} fausses) sur ${span} s`
    );
    console.log(`écart entre vrais points d'accès : moyen ${mean(gaps).toFixed(1)} s, max ${Math.max(...gaps).toFixed(1)} s`);
    console.log(
      `surcoût de ce correctif : ${hurt.length} cibles sur ${added.length} touchées (${((100 * hurt.length) / added.length).toFixed(1)}%), ` +
        `retard moyen quand ça touche ${hurt.length ? mean(hurt).toFixed(1) : "0"} s, max ${Math.max(0, ...added).toFixed(1)} s`
    );
    void late;
    source.close();
  });
});

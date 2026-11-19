import { describe, it } from "vitest";
import { openSync, readSync, closeSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMatroska } from "@/lib/webcodecs/matroska";
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

function* walk(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.toLowerCase().endsWith(".mkv")) yield p;
  }
}

// Header only: no sample scanning, so the whole library is a few minutes rather than an hour.
describe.skipIf(!process.env.BENCH_ROOT)("sous-titres", () => {
  it("recense ce que la bibliothèque contient", { timeout: 3_600_000 }, async () => {
    const rows: { path: string; subs: string[]; width: number; height: number }[] = [];
    for (const path of [...walk(process.env.BENCH_ROOT!)].slice(0, Number(process.env.BENCH_LIMIT ?? 99999))) {
      const source = fileSource(path);
      try {
        const file = await parseMatroska(source);
        const video = file.tracks.find((t) => t.type === "video");
        rows.push({
          path,
          subs: file.tracks.filter((t) => t.type === "subtitle").map((t) => t.codecId),
          width: video?.video?.width ?? 0,
          height: video?.video?.height ?? 0,
        });
      } catch { /* compté comme illisible plus bas */ }
      finally { source.close(); }
      if (rows.length % 200 === 0) console.log(`  ${rows.length}…`);
    }
    writeFileSync(process.env.BENCH_OUT!, JSON.stringify(rows));
    console.log(`écrit : ${rows.length} fichiers`);
  });
});

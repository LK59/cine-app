// Inventaire des pistes son, pour choisir l'échantillon du banc demux-son.
import { it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync, appendFileSync } from "node:fs";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
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

it.skipIf(!process.env.CENSUS_FILES)("inventaire", async () => {
  for (const path of readFileSync(process.env.CENSUS_FILES!, "utf8").split("\n").filter(Boolean)) {
    const source = fileSource(path);
    try {
      const file = await openMediaFile(source);
      const audio = file.tracks.filter((t) => t.type === "audio").map((t) => ({ n: t.number, codec: t.codecId, ch: t.audio?.channels, lang: t.language }));
      appendFileSync(process.env.CENSUS_OUT!, JSON.stringify({ path, mp4: !!file.mp4, audio }) + "\n");
    } catch (e) {
      appendFileSync(process.env.CENSUS_OUT!, JSON.stringify({ path, error: String(e).slice(0, 150) }) + "\n");
    } finally {
      source.close?.();
    }
  }
}, 3_600_000);

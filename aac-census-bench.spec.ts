// Recensement des AAC à PCE de la bibliothèque (DECISIONS.md §62) — sauté sans AAC_CENSUS.
//
// Lit l'en-tête de chaque fichier listé (une ligne par chemin) et classe chaque piste A_AAC par la
// décision d'`aacPlan` (copie, réécriture, décodage mesuré ou L R C), selon que le navigateur
// accepte ou non un PCE tel quel. Ne remultiplexe rien.
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e AAC_CENSUS=/app/liste.txt node:24-alpine npx vitest run aac-census-bench.spec.ts
import { describe, it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync } from "node:fs";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { aacPlan, parseAacConfig } from "@/lib/webcodecs/aacConfig";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

function fileSource(path: string): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    read: async (start: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - start));
      const buffer = Buffer.alloc(length);
      const n = length > 0 ? readSync(fd, buffer, 0, length, start) : 0;
      return new Uint8Array(buffer.subarray(0, n));
    },
    close: () => closeSync(fd),
  };
}

describe.skipIf(!process.env.AAC_CENSUS)("recensement des AAC à PCE", () => {
  it("classe chaque piste AAC", { timeout: 3_600_000 }, async () => {
    const files = readFileSync(process.env.AAC_CENSUS!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const counts: Record<string, number> = {};
    const pce: string[] = [];
    for (const path of files) {
      let source: ByteSource | null = null;
      try {
        source = fileSource(path);
        const file = await openMediaFile(source);
        for (const t of file.tracks.filter((x) => x.type === "audio" && x.codecId === "A_AAC")) {
          const config = parseAacConfig(t.codecPrivate);
          const refused = aacPlan(t.codecPrivate, { pceAccepted: false, orderMeasured: true });
          const key = `${t.audio?.channels}ch ${config?.pce ? "PCE" : "standard"} → ${refused.action}${refused.action === "decode" ? (refused.measured ? " mesuré" : " L R C") : ""}`;
          counts[key] = (counts[key] ?? 0) + 1;
          if (config?.pce) pce.push(`${path.split("/").pop()} piste ${t.number} ${t.audio?.channels}ch → ${key}`);
        }
      } catch (e) {
        counts["illisible"] = (counts["illisible"] ?? 0) + 1;
        console.log(`ILLISIBLE ${path}: ${String(e).slice(0, 80)}`);
      } finally {
        source?.close();
      }
    }
    console.log(`RECENSEMENT ${files.length} fichiers ${JSON.stringify(counts)}`);
    for (const line of pce) console.log(`PCE ${line}`);
  });
});

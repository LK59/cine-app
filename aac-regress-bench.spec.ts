// Banc de non-régression de l'AAC (DECISIONS.md §62) — sauté sans AAC_FILES.
//
// Pour chaque fichier (une ligne par chemin dans AAC_FILES) et chaque piste A_AAC : ouvre le
// remultiplexeur comme le lecteur (par piste), puis écrit la décision (copie ou ré-encodage, type
// MIME du son), l'empreinte du segment d'initialisation audio, si l'AudioSpecificConfig d'origine
// est dans l'esds, et l'empreinte des octets audio des huit premiers segments. Lancé sur deux
// versions du code, les lignes doivent être identiques pour tout AAC standard.
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e AAC_FILES=/app/aac-files.txt -e AAC_OUT=/app/aac-out.jsonl node:24-alpine npx vitest run aac-regress-bench.spec.ts
import { describe, it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

// AAC_UA : le moteur simulé (Chromium ou WebKit) pour le code qui décide d'après lui.
if (process.env.AAC_UA) Object.defineProperty(globalThis, "navigator", { value: { userAgent: process.env.AAC_UA }, configurable: true });
const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

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
const hex = (b: Uint8Array | null | undefined) => (b ? Buffer.from(b).toString("hex") : null);

describe.skipIf(!process.env.AAC_FILES)("non-régression AAC", () => {
  it("décide et produit les mêmes octets", { timeout: 1_200_000 }, async () => {
    const files = readFileSync(process.env.AAC_FILES!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const path of files) {
      const source = fileSource(path);
      try {
        const file = await openMediaFile(source);
        const video = file.tracks.find((t) => t.type === "video");
        if (!video) continue;
        for (const audio of file.tracks.filter((t) => t.type === "audio")) {
          const row: Record<string, unknown> = { file: path.split("/").pop(), track: audio.number, codec: audio.codecId, channels: audio.audio?.channels, asc: audio.codecId === "A_AAC" ? hex(audio.codecPrivate) : null };
          try {
            const remuxer = await Remuxer.open(source, file, video, audio, { width: 1920, height: 1080 }, null, 0, { perTrack: true });
            const plan = remuxer.plan();
            const diag = remuxer.diagnostics();
            row.mime = plan.audioMimeType;
            row.transcoded = diag.transcodedAudio;
            row.init = sha(plan.audioInit);
            row.ascInEsds = audio.codecPrivate && plan.audioInit ? Buffer.from(plan.audioInit).indexOf(Buffer.from(audio.codecPrivate)) >= 0 : null;
            const hash = createHash("sha256");
            let bytes = 0;
            let end = 0;
            for (let i = 0; i < 8; i++) {
              const segment = await remuxer.nextSegment();
              if (!segment) break;
              if (segment.audio) {
                hash.update(segment.audio);
                bytes += segment.audio.byteLength;
              }
              end = segment.endSeconds;
            }
            row.audio8 = hash.digest("hex").slice(0, 16);
            row.audioBytes = bytes;
            row.endSeconds = Math.round(end * 1000) / 1000;
          } catch (e) {
            row.error = String(e instanceof Error ? e.message : e).slice(0, 160);
          }
          appendFileSync(process.env.AAC_OUT!, JSON.stringify(row) + "\n");
        }
      } finally {
        source.close();
      }
    }
  });
});

// Banc d'identité du chemin MediaSource — sauté sans REMUX_FILES.
//
// Le lecteur de production remuxe dans la page (`Remuxer`, `mp4Muxer.ts`). Né pour Lumen serveur, qui partageait le
// muxer et y ajoutait des options (DECISIONS §154, §157 ; archivé, §196) : tout changement du muxer ou du remuxeur doit
// laisser **chaque octet** du chemin MediaSource tel qu'il était, sauf intention. Ce banc ouvre le remuxeur
// exactement comme le lecteur (par piste, sans option), et écrit l'empreinte SHA-256 des init segments et de
// chaque segment produit — douze depuis le début, puis douze après chacun de deux sauts (à 30 et 60 % du
// film : un départ sur une CRA y écarte ses RASL, le chemin de §RASL). Lancé sur le code d'avant et sur
// celui d'après, les sorties doivent être identiques à l'octet.
//
//   docker run --rm --name remux-hash -v "$PWD":/app -v /mnt/media/video:/media:ro -v <sorties>:/out -w /app \
//     -e REMUX_FILES=/out/liste.txt -e REMUX_OUT=/out/apres.jsonl node:26-alpine npx vitest run remux-hash-bench.spec.ts
//
// REMUX_FILES : un chemin par ligne. Le son est la première piste que le remuxeur copie telle quelle
// (AAC, AC-3, E-AC-3, FLAC) : il n'y a pas d'`AudioEncoder` dans Node.
import { describe, it } from "vitest";
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

// Un moteur qui accepte tout, comme Safari qui lit l'(E-)AC-3 : la décision de copie se prend comme chez lui.
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15" },
  configurable: true,
});
const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

function fileSource(path: string): ByteSource & { close: () => void } {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    async read(offset: number, length: number) {
      const n = Math.max(0, Math.min(length, size - offset));
      const buffer = new Uint8Array(n);
      let at = 0;
      while (at < n) {
        const got = readSync(fd, buffer, at, n - at, offset + at);
        if (got <= 0) break;
        at += got;
      }
      return buffer.subarray(0, at);
    },
    close: () => closeSync(fd),
  } as ByteSource & { close: () => void };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const COPIED = new Set(["A_AAC", "A_AC3", "A_EAC3", "A_FLAC"]);
const PER_RUN = 12;

describe.skipIf(!process.env.REMUX_FILES)("identité du chemin MediaSource", () => {
  it("empreinte des init et des segments, du début et après deux sauts", { timeout: 1_800_000 }, async () => {
    const out = process.env.REMUX_OUT ?? "/out/empreintes.jsonl";
    for (const path of readFileSync(process.env.REMUX_FILES!, "utf8").split("\n").filter(Boolean)) {
      const source = fileSource(path);
      try {
        const file = await openMediaFile(source);
        const video = file.tracks.find((t) => t.type === "video")!;
        const audio = file.tracks.find((t) => t.type === "audio" && COPIED.has(t.codecId)) ?? null;
        const remuxer = await Remuxer.open(source, file, video, audio, { width: video.video?.width ?? 1920, height: video.video?.height ?? 1080 }, video.dolbyVision ?? null, 0, { perTrack: true });
        const plan = remuxer.plan();
        const line: Record<string, unknown> = { path, audio: audio?.codecId ?? null, videoInit: sha(plan.videoInit), audioInit: plan.audioInit ? sha(plan.audioInit) : null };
        const duration = file.durationSeconds ?? 0;
        for (const [name, at] of [["debut", 0], ["saut30", duration * 0.3], ["saut60", duration * 0.6]] as const) {
          if (at > 0) remuxer.seekTo(at);
          const hashes: string[] = [];
          for (let i = 0; i < PER_RUN; i++) {
            const segment = await remuxer.nextSegment();
            if (!segment) break;
            hashes.push(`${segment.video.map(sha).join("+")}|${segment.audio ? sha(segment.audio) : "-"}|${segment.endSeconds.toFixed(6)}`);
          }
          line[name] = hashes;
        }
        appendFileSync(out, `${JSON.stringify(line)}\n`);
      } finally {
        source.close();
      }
    }
  });
});

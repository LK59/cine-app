// Banc de l'AAC à PCE (DECISIONS.md §62) — sauté sans répertoire de sortie.
//
// Deux vérifications que les tests synthétiques ne peuvent pas faire, parce qu'elles passent par
// ffmpeg ou par un vrai navigateur :
//
// 1. La réécriture sans perte (couche 2). AAC_PCE_FILE : un fichier vidéo + AAC 5.1 standard. Sa
//    configuration est remplacée par un PCE équivalent (avant [mono, paire], arrière [paire],
//    caisson, étiquettes canoniques, l'extension 0x2b7 recopiée), puis le fichier est
//    remultiplexé : la décision doit être `rewrite`, la configuration écrite dans le segment
//    d'initialisation doit être exactement celle d'origine, et `<out>.rewrite.audio.mp4` se décode
//    canal pour canal comme la source (à comparer avec ffmpeg, voir plus bas).
// 2. La question au navigateur (couche 4). Écrit `<out>.probe-pce.*` (le segment d'initialisation
//    et la trame silencieuse de la sonde, PCE de Ruby) et `<out>.probe-std.*` (les mêmes au 5.1
//    standard), à envoyer à un vrai MediaSource — le second sert de témoin.
//
//   docker run --rm -v "$PWD":/app -v /dev/shm:/shm -w /app \
//     -e AAC_PCE_OUT=/shm/aacpce -e AAC_PCE_FILE=/shm/eq51.mkv node:24-alpine npx vitest run aac-pce-bench.spec.ts
//   ffmpeg -i /shm/aacpce.rewrite.audio.mp4 -af astats=measure_overall=none:measure_perchannel=RMS_level -f null -
//
// Mesuré le 10/10/2026 : décision `rewrite`, configuration réécrite `11 b0 56 e5 00` identique à
// l'originale, les six tonalités (300, 500, 700, 60, 900, 1 100 Hz) ressortent au même rang et au
// même niveau qu'à la source ; dans Chromium, le PCE de la sonde est refusé au segment
// d'initialisation et le 5.1 standard tamponné.
import { describe, expect, it } from "vitest";
import { openSync, readSync, statSync, closeSync, writeFileSync } from "node:fs";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import { audioSampleEntryFor } from "@/lib/webcodecs/mp4SampleEntries";
import { initSegment, mediaSegment, type MuxTrackInfo } from "@/lib/webcodecs/mp4Muxer";
import { PROBE_ASC, PROBE_FRAME } from "@/lib/webcodecs/aacPceProbe";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

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

/** Le PCE équivalent au 5.1 standard : avant [mono C, paire L R], arrière [paire], un caisson. */
function equivalentPce(standard: Uint8Array): Uint8Array {
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  const objectType = standard[0] >> 3;
  const frequencyIndex = ((standard[0] & 7) << 1) | (standard[1] >> 7);
  put(objectType, 5);
  put(frequencyIndex, 4);
  put(0, 4);
  put(0, 3);
  put(0, 4);
  put(1, 2);
  put(frequencyIndex, 4);
  put(2, 4); // avant : C, puis L R
  put(0, 4);
  put(1, 4); // arrière : Ls Rs
  put(1, 2); // un caisson
  put(0, 3);
  put(0, 4);
  put(0, 3);
  put(0, 1);
  put(0, 4); // SCE 0
  put(1, 1);
  put(0, 4); // CPE 0
  put(1, 1);
  put(1, 4); // CPE 1
  put(0, 4); // LFE 0
  while (bits.length % 8) bits.push(0);
  put(0, 8); // pas de commentaire
  // Ce qui suit la configuration standard (2 octets) : l'extension 0x2b7 de FFmpeg, recopiée.
  for (const byte of standard.subarray(2)) put(byte, 8);
  return Uint8Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((v, b) => (v << 1) | b, 0));
}

const join = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe.skipIf(!process.env.AAC_PCE_OUT)("banc de l'AAC à PCE", () => {
  const out = process.env.AAC_PCE_OUT!;

  it("écrit les segments de la sonde, PCE et témoin standard", () => {
    // Une trame silencieuse 5.1 standard de FFmpeg, 48 kHz, sans en-tête ADTS.
    const stdFrame = Uint8Array.from([0x01, 0x18, 0x20, 0x01, 0x08, 0x80, 0x23, 0x04, 0x60, 0x23, 0x10, 0x04, 0x60, 0x8c, 0x0c, 0x23, 0x00, 0x00, 0xe0]);
    for (const [name, asc, frame] of [
      ["probe-pce", PROBE_ASC, PROBE_FRAME],
      ["probe-std", Uint8Array.from([0x11, 0xb0, 0x56, 0xe5, 0x00]), stdFrame],
    ] as const) {
      const track: MuxTrackInfo = {
        id: 1,
        kind: "audio",
        timescale: 48000,
        sampleEntry: audioSampleEntryFor({ codecId: "A_AAC", codecPrivate: asc, channels: 6, sampleRate: 48000, firstFrame: null }),
        width: 0,
        height: 0,
        language: "und",
      };
      writeFileSync(`${out}.${name}.init.mp4`, initSegment(track, 0));
      writeFileSync(
        `${out}.${name}.media.m4s`,
        mediaSegment(track, 1, [
          { data: frame, decodeTime: 0, duration: 1024, compositionOffset: 0, isKeyframe: true },
          { data: frame, decodeTime: 1024, duration: 1024, compositionOffset: 0, isKeyframe: true },
        ])
      );
    }
  });

  it.skipIf(!process.env.AAC_PCE_FILE)("réécrit un PCE équivalent au 5.1 et copie les trames", { timeout: 120_000 }, async () => {
    const source = fileSource(process.env.AAC_PCE_FILE!);
    const file = await openMediaFile(source);
    const video = file.tracks.find((t) => t.type === "video")!;
    const audio = file.tracks.find((t) => t.type === "audio")!;
    const original = audio.codecPrivate!;
    (audio as { codecPrivate: Uint8Array | null }).codecPrivate = equivalentPce(original);
    console.log(`AAC_PCE origine ${hex(original)} → PCE équivalent ${hex(audio.codecPrivate!)}`);
    const remuxer = await Remuxer.open(source, file, video, audio, { width: 320, height: 180 }, null, 0, { perTrack: true });
    const plan = remuxer.plan();
    const init = plan.audioInit!;
    // La configuration écrite dans l'esds : la seule occurrence de l'originale doit y être.
    const at = Buffer.from(init).indexOf(Buffer.from(original));
    console.log(`AAC_PCE décision ${plan.audioMimeType} — configuration d'origine trouvée dans l'esds : ${at >= 0}`);
    expect(at).toBeGreaterThan(0);
    expect(Buffer.from(init).indexOf(Buffer.from(audio.codecPrivate!))).toBe(-1);
    const parts: Uint8Array[] = [init];
    for (let i = 0; i < 8; i++) {
      const segment = await remuxer.nextSegment();
      if (!segment) break;
      if (segment.audio) parts.push(segment.audio);
    }
    writeFileSync(`${out}.rewrite.audio.mp4`, join(parts));
    source.close();
  });
});

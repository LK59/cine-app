import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import { MemoryByteSource } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer, type TrackedCue } from "@/lib/webcodecs/remuxer";
import type { MatroskaFile } from "@/lib/webcodecs/matroska";

// Un MP4 de bout en bout dans le vrai remultiplexeur — le même que pour un Matroska, sans double :
// ce qui sort doit être le fichier d'origine, échantillon pour échantillon, sur la même ligne de
// temps. Vérifié une fois à la main en faisant décoder la sortie par ffmpeg (aucune erreur, durées
// audio et vidéo alignées) ; ce qui suit encode ces constats en assertions sur les boîtes.

const DIR = "src/__tests__/fixtures/mp4";

// Le navigateur accepte tout ici : chaque piste passe telle quelle, comme sur un iPhone qui prend
// l'AC-3, et aucun encodeur n'est nécessaire.
beforeAll(() => {
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
});
afterAll(() => vi.unstubAllGlobals());

interface Packet {
  stream: number;
  pts: number;
  size: number;
  pos: number;
  key: boolean;
}

function packets(name: string): Packet[] {
  return readFileSync(`${DIR}/${name}.packets.csv`, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [stream, pts, , , size, pos, flags] = line.split(",");
      return { stream: +stream, pts: +pts, size: +size, pos: +pos, key: flags.startsWith("K") };
    });
}

interface OutSample {
  decode: number;
  presentation: number;
  size: number;
  key: boolean;
  data: Uint8Array;
}

/** Les échantillons d'un segment média fMP4 : moof (tfdt, trun) puis mdat. */
function readSegment(segment: Uint8Array): OutSample[] {
  const dv = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  const type = (at: number) => String.fromCharCode(...segment.subarray(at + 4, at + 8));
  const out: OutSample[] = [];
  let at = 0;
  while (at + 8 <= segment.length) {
    const size = dv.getUint32(at);
    if (type(at) === "moof") {
      const moofStart = at;
      let tfdt = 0;
      let entries: { duration: number; size: number; flags: number; cto: number }[] = [];
      let dataOffset = 0;
      const walk = (from: number, to: number) => {
        let p = from;
        while (p + 8 <= to) {
          const s = dv.getUint32(p);
          const t = type(p);
          if (t === "traf") walk(p + 8, p + s);
          if (t === "tfdt") tfdt = dv.getUint32(p + 12) * 2 ** 32 + dv.getUint32(p + 16);
          if (t === "trun") {
            const count = dv.getUint32(p + 12);
            dataOffset = dv.getInt32(p + 16);
            entries = Array.from({ length: count }, (_, i) => ({
              duration: dv.getUint32(p + 20 + i * 16),
              size: dv.getUint32(p + 24 + i * 16),
              flags: dv.getUint32(p + 28 + i * 16),
              cto: dv.getInt32(p + 32 + i * 16),
            }));
          }
          p += s;
        }
      };
      walk(at + 8, at + size);
      let decode = tfdt;
      let data = moofStart + dataOffset;
      for (const e of entries) {
        out.push({
          decode,
          presentation: decode + e.cto,
          size: e.size,
          key: (e.flags & 0x00010000) === 0,
          data: segment.subarray(data, data + e.size),
        });
        decode += e.duration;
        data += e.size;
      }
    }
    at += size;
  }
  return out;
}

/** Le contenu d'une boîte, trouvée par son nom n'importe où dans un segment d'initialisation. */
function findBox(bytes: Uint8Array, name: string): Uint8Array | null {
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (String.fromCharCode(...bytes.subarray(i, i + 4)) === name) {
      const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(i - 4);
      return bytes.subarray(i + 4, i - 4 + size);
    }
  }
  return null;
}

async function open(name: string, audioNumber: number) {
  const fileBytes = new Uint8Array(readFileSync(`${DIR}/${name}.mp4`));
  const source = new MemoryByteSource(fileBytes);
  const file: MatroskaFile = await openMediaFile(source);
  const video = file.tracks.find((t) => t.type === "video")!;
  const audio = file.tracks.find((t) => t.number === audioNumber)!;
  const remuxer = await Remuxer.open(source, file, video, audio, { width: 64, height: 48 });
  return { fileBytes, file, video, audio, remuxer };
}

async function drain(remuxer: Remuxer) {
  const video: OutSample[] = [];
  const audio: OutSample[] = [];
  const subtitles: TrackedCue[] = [];
  for (let segment = await remuxer.nextSegment(); segment; segment = await remuxer.nextSegment()) {
    for (const fragment of segment.video) video.push(...readSegment(fragment));
    if (segment.audio) audio.push(...readSegment(segment.audio));
    subtitles.push(...segment.subtitles);
  }
  return { video, audio, subtitles };
}

describe("un MP4 dans le remultiplexeur", () => {
  it("H.264 + AAC : chaque échantillon recopié, sur la ligne de temps d'origine", async () => {
    const { fileBytes, file, video, remuxer } = await open("a-faststart", 2);
    const plan = remuxer.plan();
    expect(plan.videoMimeType).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6}"$/);
    expect(plan.audioMimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(plan.durationSeconds).toBe(1);
    // L'enregistrement de configuration du fichier, tel quel dans l'entrée d'échantillon.
    expect(findBox(plan.videoInit, "avcC")).toEqual(video.codecPrivate);

    const out = await drain(remuxer);
    const delayUs = remuxer.diagnostics().presentationDelaySeconds * 1e6;
    const reference = packets("a-faststart");

    const refVideo = reference.filter((p) => p.stream === 0);
    expect(out.video).toHaveLength(refVideo.length);
    out.video.forEach((sample, i) => {
      // Les octets eux-mêmes, lus là où ffprobe dit qu'ils sont.
      expect(sample.data).toEqual(fileBytes.subarray(refVideo[i].pos, refVideo[i].pos + refVideo[i].size));
      expect(sample.key).toBe(refVideo[i].key);
      expect(Math.abs(sample.presentation - delayUs - (refVideo[i].pts * 1e6) / 12288)).toBeLessThanOrEqual(1);
    });
    // Le décodage précède toujours la présentation, et ne recule jamais.
    out.video.forEach((s, i) => {
      expect(s.presentation).toBeGreaterThanOrEqual(s.decode);
      if (i > 0) expect(s.decode).toBeGreaterThan(out.video[i - 1].decode);
    });

    const refAudio = reference.filter((p) => p.stream === 1);
    expect(out.audio).toHaveLength(refAudio.length);
    out.audio.forEach((sample, i) => {
      expect(sample.size).toBe(refAudio[i].size);
      expect(Math.abs(sample.decode - delayUs - (refAudio[i].pts * 1e6) / 48000)).toBeLessThanOrEqual(1);
    });
    // L'amorce AAC (−21,3 ms) reste avant l'image, décalée du même retard qu'elle : rien de négatif.
    expect(out.audio[0].decode).toBeGreaterThan(0);
    // Image et son finissent ensemble, à une trame audio près.
    // (La dernière image présentée, pas la dernière décodée : une B-image se décode avant elle.)
    const videoEnd = Math.max(...out.video.map((s) => s.presentation)) + 41_667;
    const audioEnd = out.audio[out.audio.length - 1].decode + 21_333;
    expect(Math.abs(videoEnd - audioEnd)).toBeLessThan(25_000);
    expect(file.cues).toHaveLength(2);
  });

  it("HEVC + AC-3 : l'AC-3 décrit depuis sa trame, les sous-titres mov_text collectés", async () => {
    const { remuxer } = await open("c-hevc-multi", 3);
    const plan = remuxer.plan();
    expect(plan.videoMimeType).toMatch(/^video\/mp4; codecs="hvc1\./);
    expect(plan.audioMimeType).toBe('audio/mp4; codecs="ac-3"');
    expect(findBox(plan.audioInit!, "dac3")).not.toBeNull();

    const out = await drain(remuxer);
    const reference = packets("c-hevc-multi");
    expect(out.video).toHaveLength(reference.filter((p) => p.stream === 0).length);
    expect(out.audio.map((s) => s.size)).toEqual(reference.filter((p) => p.stream === 2).map((p) => p.size));

    // Toutes les pistes de texte d'un coup, sur l'horloge du lecteur — et les silences entre les
    // répliques, vides, n'y sont pas.
    const delay = remuxer.diagnostics().presentationDelaySeconds;
    const cues = out.subtitles.map((c) => [c.track, c.text, +(c.startSeconds - delay).toFixed(3), +(c.endSeconds - delay).toFixed(3)]);
    expect(cues.sort()).toEqual(
      [
        [4, "Bonjour", 0.1, 0.4],
        [4, "Au revoir", 0.6, 0.9],
        [5, "Hello", 0.2, 0.7],
      ].sort()
    );
  });

  it("un saut repart sur l'image clé qui précède, avec son son", async () => {
    const { remuxer } = await open("a-faststart", 2);
    await remuxer.nextSegment();
    remuxer.seekTo(0.6);
    const segment = await remuxer.nextSegment();
    expect(remuxer.diagnostics().segmentStartSeconds).toBe(0.5);
    const video = segment!.video.flatMap(readSegment);
    expect(video[0].key).toBe(true);
    const delayUs = remuxer.diagnostics().presentationDelaySeconds * 1e6;
    expect(video[0].presentation - delayUs).toBe(500_000);
    const audio = readSegment(segment!.audio!);
    expect(audio[0].decode - delayUs).toBeLessThanOrEqual(500_000);
    expect(audio[0].decode - delayUs).toBeGreaterThan(400_000);
  });

  it("une pochette rangée comme piste n'est jamais prise pour le film", async () => {
    const { video, remuxer } = await open("f-cover-track", 3);
    expect(video.number).toBe(2);
    const out = await drain(remuxer);
    expect(out.video).toHaveLength(packets("f-cover-track").filter((p) => p.stream === 1).length);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { MemoryByteSource } from "@/lib/webcodecs/byteSource";
import { clusterOffsetForTime, keptRangeAt, parseMatroska, type MatroskaFile, type MediaSample } from "@/lib/webcodecs/matroska";
import { parseMp4, timedText, isIsoBaseMedia } from "@/lib/webcodecs/mp4Demux";
import { createSampleReader, openMediaFile } from "@/lib/webcodecs/mediaFile";

// Le démultiplexeur MP4 tenu à ce que FFmpeg lit des mêmes octets. Les fichiers sont synthétiques
// (src/__tests__/fixtures/mp4/generate.sh, mire et sinus de FFmpeg) et chacun a, à côté, la liste
// de ses paquets telle que ffprobe la donne : instant, taille, position dans le fichier, image
// clé. Deux lectures d'un même fichier qui divergent, c'est précisément le défaut à trouver — la
// langue absente d'un Matroska l'a appris au lecteur (CLAUDE.md).

const DIR = "src/__tests__/fixtures/mp4";
const bytes = (name: string) => new Uint8Array(readFileSync(`${DIR}/${name}`));
const source = (name: string) => new MemoryByteSource(bytes(name));

interface Packet {
  stream: number;
  pts: number;
  dts: number;
  duration: number;
  size: number;
  pos: number;
  key: boolean;
}

function packets(name: string): Packet[] {
  return readFileSync(`${DIR}/${name}.packets.csv`, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [stream, pts, dts, duration, size, pos, flags] = line.split(",");
      return { stream: +stream, pts: +pts, dts: +dts, duration: +duration, size: +size, pos: +pos, key: flags.startsWith("K") };
    });
}

/** Un hvcC dont chaque tableau de NAL a son bit `array_completeness` baissé. */
function withoutCompleteness(hvcC: Uint8Array): Uint8Array {
  const copy = hvcC.slice();
  let at = 23;
  for (let a = 0; a < copy[22] && at < copy.length; a++) {
    copy[at] &= 0x7f;
    const count = (copy[at + 1] << 8) | copy[at + 2];
    at += 3;
    for (let n = 0; n < count; n++) at += 2 + ((copy[at] << 8) | copy[at + 1]);
  }
  return copy;
}

/** Tout ce que le lecteur rend depuis le début du fichier. */
async function readAll(file: MatroskaFile, src: MemoryByteSource): Promise<MediaSample[]> {
  const reader = createSampleReader(src, file, file.firstClusterOffset!);
  const out: MediaSample[] = [];
  for (let sample = await reader.next(); sample; sample = await reader.next()) out.push(sample);
  expect(reader.exhausted).toBe(true);
  return out;
}

/**
 * Compare, piste par piste, ce que lit le démultiplexeur à ce que lit ffprobe : instants de
 * présentation (au µs près), tailles, images clés, positions dans le fichier, durées.
 *
 * `timeBases` donne, pour chaque flux ffprobe (dans l'ordre), le dénominateur de sa base de temps
 * et le numéro de piste MP4 qui lui correspond.
 */
async function expectMatchesFfprobe(name: string, timeBases: Record<number, { den: number; track: number }>) {
  const src = source(`${name}.mp4`);
  const file = await parseMp4(src);
  const samples = await readAll(file, src);
  const reference = packets(name);
  for (const [stream, { den, track }] of Object.entries(timeBases)) {
    const expected = reference.filter((p) => p.stream === Number(stream));
    let ours = samples.filter((s) => s.trackNumber === track);
    const index = file.mp4!.tracks.find((t) => t.number === track)!;
    const text = file.tracks.find((t) => t.number === track)!.codecId === "S_TEXT/UTF8";
    // FFmpeg tait le dernier échantillon mov_text, vide et de durée nulle, que le multiplexeur
    // écrit pour clore la dernière réplique. Nous le rendons : un texte vide n'affiche rien.
    if (text && ours.length === expected.length + 1 && ours[ours.length - 1].data.length === 0) ours = ours.slice(0, -1);
    expect(ours.length, `${name} piste ${track}`).toBe(expected.length);
    // Dans l'ordre de décodage, comme ffprobe les rend pour une piste donnée.
    expected.forEach((p, i) => {
      expect(Math.abs(ours[i].timestampUs - (p.pts * 1e6) / den), `${name} piste ${track} n°${i} pts`).toBeLessThanOrEqual(1);
      // Les écarts de décodage, pas les instants : devant un décalage de composition négatif,
      // FFmpeg recule toute la ligne de décodage d'une constante (`dts_shift`), que le fichier
      // n'écrit pas. Ce sont les présentations, vérifiées au-dessus, qui fixent le temps.
      expect(
        Math.abs(index.dtsUs[i] - index.dtsUs[0] - ((p.dts - expected[0].dts) * 1e6) / den),
        `${name} piste ${track} n°${i} dts`
      ).toBeLessThanOrEqual(1);
      expect(index.offsets[i], `${name} piste ${track} n°${i} position`).toBe(p.pos);
      expect(index.sizes[i]).toBe(p.size);
      if (!text) expect(ours[i].data.byteLength).toBe(p.size);
      expect(ours[i].isKey, `${name} piste ${track} n°${i} clé`).toBe(p.key);
      // La dernière durée est rognée par FFmpeg à la fin de la liste de montage ; les autres
      // sont l'écart au suivant, comme stts les écrit.
      if (i < expected.length - 1) expect(Math.abs(ours[i].durationUs! - (p.duration * 1e6) / den)).toBeLessThanOrEqual(1);
    });
  }
  return { file, samples };
}

describe("reconnaître le conteneur", () => {
  it("à ses octets, jamais à son nom", async () => {
    expect(isIsoBaseMedia(bytes("a-faststart.mp4").subarray(0, 12))).toBe(true);
    expect(isIsoBaseMedia(bytes("c-hevc-multi.mkv").subarray(0, 12))).toBe(false);
    // Un QuickTime ancien peut commencer par `wide` ou directement par `mdat`.
    expect(isIsoBaseMedia(new Uint8Array([0, 0, 0, 8, 0x77, 0x69, 0x64, 0x65]))).toBe(true);

    expect((await openMediaFile(source("a-faststart.mp4"))).mp4).toBeDefined();
    // Un Matroska reste lu par le lecteur Matroska, à l'identique.
    const mkv = await openMediaFile(source("c-hevc-multi.mkv"));
    expect(mkv.mp4).toBeUndefined();
    expect(mkv).toEqual(await parseMatroska(source("c-hevc-multi.mkv")));
  });
});

describe("parseMp4 — les pistes", () => {
  it("décrit chaque piste comme son jumeau Matroska : codecs, langues, enregistrements", async () => {
    const mp4 = await parseMp4(source("c-hevc-multi.mp4"));
    const mkv = await parseMatroska(source("c-hevc-multi.mkv"));

    expect(mp4.tracks.map((t) => [t.number, t.type, t.codecId, t.language])).toEqual([
      [1, "video", "V_MPEGH/ISO/HEVC", null],
      [2, "audio", "A_AAC", "eng"],
      [3, "audio", "A_AC3", "fre"],
      [4, "subtitle", "S_TEXT/UTF8", "fre"],
      [5, "subtitle", "S_TEXT/UTF8", "eng"],
    ]);
    // Les enregistrements de configuration, à l'octet près : c'est ce que le remultiplexeur
    // recopie dans l'entrée d'échantillon, et ce que le décodeur lit. À un bit près pour le hvcC,
    // que le multiplexeur Matroska de FFmpeg réécrit : `array_completeness`, 1 dans une entrée
    // `hvc1` (les paramètres sont tous là), 0 dans un Matroska (ils peuvent venir en bande).
    expect(withoutCompleteness(mp4.tracks[0].codecPrivate!)).toEqual(withoutCompleteness(mkv.tracks[0].codecPrivate!));
    expect(mp4.tracks[1].codecPrivate).toEqual(mkv.tracks[1].codecPrivate);
    expect(mp4.tracks[0].video).toMatchObject({ width: 64, height: 48 });
    for (const i of [1, 2]) {
      expect(mp4.tracks[i].audio?.sampleRate).toBe(mkv.tracks[i].audio?.sampleRate);
      expect(mp4.tracks[i].audio?.channels).toBe(mkv.tracks[i].audio?.channels);
    }
    // Le drapeau « activée » de tkhd tient lieu de « par défaut » — ce que FFmpeg, donc Jellyfin,
    // en lit (disposition default=1 sur l'AAC, 0 sur l'AC-3).
    expect(mp4.tracks.map((t) => t.isDefault)).toEqual([true, true, false, true, false]);
    // Mais chaque piste reste offerte : « activée » n'y veut pas dire « utilisable ».
    expect(mp4.tracks.every((t) => t.isEnabled)).toBe(true);
    expect(mp4.durationSeconds).toBe(1);
  });

  it("reconstruit l'OpusHead et l'en-tête FLAC qu'un Matroska garde, et compte les canaux de l'E-AC3", async () => {
    const mp4 = await parseMp4(source("g-audio-codecs.mp4"));
    const mkv = await parseMatroska(source("g-audio-codecs.mkv"));
    expect(mp4.tracks.map((t) => t.codecId)).toEqual(["V_MPEG4/ISO/AVC", "A_OPUS", "A_FLAC", "A_EAC3"]);
    expect(mp4.tracks[0].codecPrivate).toEqual(mkv.tracks[0].codecPrivate);
    expect(mp4.tracks[1].codecPrivate).toEqual(mkv.tracks[1].codecPrivate);
    expect(mp4.tracks[2].codecPrivate).toEqual(mkv.tracks[2].codecPrivate);
    for (const i of [1, 2, 3]) {
      expect(mp4.tracks[i].audio?.sampleRate, mp4.tracks[i].codecId).toBe(mkv.tracks[i].audio?.sampleRate);
      expect(mp4.tracks[i].audio?.channels, mp4.tracks[i].codecId).toBe(mkv.tracks[i].audio?.channels);
    }
    expect(mp4.tracks[2].audio?.bitDepth).toBe(16);
    // Un MP4 écrit `und` et ne veut rien dire d'autre : pas la règle « absente = anglais » du
    // Matroska. (Le jumeau écrit `und` en toutes lettres, et le lecteur Matroska le garde tel quel.)
    expect(mp4.tracks[1].language).toBeNull();
    expect(mkv.tracks[1].language).toBe("und");
  });

  it("prend le film pour piste vidéo, pas la pochette rangée devant lui", async () => {
    const file = await parseMp4(source("f-cover-track.mp4"));
    expect(file.tracks.map((t) => [t.number, t.type])).toEqual([
      [1, "other"],
      [2, "video"],
      [3, "audio"],
    ]);
    expect(file.tracks.find((t) => t.type === "video")?.codecId).toBe("V_MPEG4/ISO/AVC");
    // Et elle n'est jamais lue.
    expect(file.mp4!.tracks.map((t) => t.number)).toEqual([2, 3]);
  });

  it("refuse un MP4 fragmenté en le disant, pour que le lecteur serveur prenne la main", async () => {
    await expect(parseMp4(source("d-fragmented.mp4"))).rejects.toThrow(/fragmenté/);
    await expect(openMediaFile(source("d-fragmented.mp4"))).rejects.toThrow(/fragmenté/);
  });

  it("trouve la description à la fin du fichier, sans lire les données", async () => {
    const src = source("b-moov-end.mp4");
    const reads: [number, number][] = [];
    const spy = { size: src.size, read: (o: number, l: number) => (reads.push([o, l]), src.read(o, l)), close: () => {} };
    const file = await parseMp4(spy);
    expect(file.tracks.map((t) => t.codecId)).toEqual(["V_MPEG4/ISO/AVC", "A_AAC"]);
    // Des en-têtes de boîtes et le `moov` : rien de la taille de `mdat`.
    const mdatSize = file.mp4!.tracks.reduce((n, t) => n + t.sizes.reduce((a, b) => a + b, 0), 0);
    expect(Math.max(...reads.map(([, l]) => l))).toBeLessThan(mdatSize);
  });
});

describe("parseMp4 — les échantillons, tels que ffprobe les lit", () => {
  it("B-images et liste de montage : décodage avant zéro, présentation à zéro", async () => {
    const { file, samples } = await expectMatchesFfprobe("a-faststart", {
      0: { den: 12288, track: 1 },
      1: { den: 48000, track: 2 },
    });
    // La première image décodée 83 ms avant zéro, montrée à zéro ; l'amorce AAC à −21,3 ms.
    expect(file.mp4!.tracks[0].dtsUs[0]).toBe(-83333);
    expect(samples.find((s) => s.trackNumber === 1)!.timestampUs).toBe(0);
    expect(samples.find((s) => s.trackNumber === 2)!.timestampUs).toBe(-21333);
  });

  it("décalages de composition signés (ctts version 1)", async () => {
    await expectMatchesFfprobe("e-bframes-ctts1", { 0: { den: 12288, track: 1 } });
  });

  it("description à la fin", async () => {
    await expectMatchesFfprobe("b-moov-end", { 0: { den: 12288, track: 1 }, 1: { den: 48000, track: 2 } });
  });

  it("HEVC, deux sons et deux sous-titres", async () => {
    await expectMatchesFfprobe("c-hevc-multi", {
      0: { den: 12288, track: 1 },
      1: { den: 48000, track: 2 },
      2: { den: 48000, track: 3 },
      3: { den: 1e6, track: 4 },
      4: { den: 1e6, track: 5 },
    });
  });

  it("Opus (pré-saut), FLAC, E-AC3", async () => {
    await expectMatchesFfprobe("g-audio-codecs", {
      0: { den: 12288, track: 1 },
      1: { den: 48000, track: 2 },
      2: { den: 8000, track: 3 },
      3: { den: 48000, track: 4 },
    });
  });

  it("rend les échantillons dans l'ordre du temps de décodage, toutes pistes mêlées", async () => {
    const src = source("c-hevc-multi.mp4");
    const file = await parseMp4(src);
    const samples = await readAll(file, src);
    const dts = new Map(file.mp4!.tracks.map((t) => [t.number, [...t.dtsUs]]));
    const seen = new Map<number, number>();
    const order = samples.map((s) => {
      const i = seen.get(s.trackNumber) ?? 0;
      seen.set(s.trackNumber, i + 1);
      return dts.get(s.trackNumber)![i];
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("mov_text", () => {
  it("rend le texte seul, et un texte vide pour le silence entre deux répliques", async () => {
    const src = source("c-hevc-multi.mp4");
    const file = await parseMp4(src);
    const samples = await readAll(file, src);
    const lines = (track: number) =>
      samples
        .filter((s) => s.trackNumber === track)
        .map((s) => [new TextDecoder().decode(s.data), s.timestampUs, s.durationUs]);
    expect(lines(4)).toEqual([
      ["", 0, 100_000],
      ["Bonjour", 100_000, 300_000],
      ["", 400_000, 200_000],
      ["Au revoir", 600_000, 300_000],
      // L'échantillon qui clôt la dernière réplique.
      ["", 900_000, 0],
    ]);
    expect(lines(5)).toEqual([
      ["", 0, 200_000],
      ["Hello", 200_000, 500_000],
      ["", 700_000, 0],
    ]);
  });

  it("laisse les boîtes de style après le texte", () => {
    const styled = new Uint8Array([0, 2, 0x48, 0x69, 0, 0, 0, 12, 0x73, 0x74, 0x79, 0x6c, 0, 0, 0, 0]);
    expect(new TextDecoder().decode(timedText(styled))).toBe("Hi");
    expect(timedText(new Uint8Array([0, 0]))).toHaveLength(0);
    expect(timedText(new Uint8Array([]))).toHaveLength(0);
  });
});

describe("l'index de saut", () => {
  it("une entrée par image de synchronisation, au temps de présentation", async () => {
    const file = await parseMp4(source("a-faststart.mp4"));
    const reference = packets("a-faststart").filter((p) => p.stream === 0 && p.key);
    expect(file.cues.map((c) => c.timeUs)).toEqual(reference.map((p) => Math.round((p.pts * 1e6) / 12288)));
    expect(file.cues.every((c) => c.track === 1)).toBe(true);
    // Une position ne dépasse jamais l'image clé qu'elle désigne : lire depuis là la rend.
    file.cues.forEach((cue, i) => expect(cue.clusterOffset).toBeLessThanOrEqual(reference[i].pos));
    expect(file.cues[0].clusterOffset).toBe(file.firstClusterOffset);
  });

  it("un saut rend l'image clé, et le son qui l'entoure", async () => {
    const src = source("a-faststart.mp4");
    const file = await parseMp4(src);
    const at = clusterOffsetForTime(file, 600_000, 1)!;
    expect(at).toBe(file.cues[1].clusterOffset);

    const reader = createSampleReader(src, file, file.firstClusterOffset!);
    await reader.next();
    reader.seekTo(at);
    const after: MediaSample[] = [];
    for (let i = 0; i < 12; i++) after.push((await reader.next())!);
    const firstVideo = after.find((s) => s.trackNumber === 1)!;
    expect(firstVideo.isKey).toBe(true);
    expect(firstVideo.timestampUs).toBe(500_000);
    // Le son repart avec l'image : pas après elle, et pas des secondes avant.
    const firstAudio = after.find((s) => s.trackNumber === 2)!;
    expect(firstAudio.timestampUs).toBeLessThanOrEqual(500_000);
    expect(firstAudio.timestampUs).toBeGreaterThan(400_000);

    // Et le retour au début rend exactement ce que rendait la première lecture — amorce du son
    // comprise (−21,3 ms), qu'un départ « au temps zéro » aurait perdue.
    reader.seekTo(file.firstClusterOffset!);
    const again: MediaSample[] = [];
    for (let i = 0; i < 4; i++) again.push((await reader.next())!);
    const fresh = createSampleReader(src, file, file.firstClusterOffset!);
    for (const sample of again) expect(sample).toEqual(await fresh.next());
    expect(again.some((s) => s.trackNumber === 2 && s.timestampUs === -21333)).toBe(true);
  });

  it("donne à la zone gardée une plage dans l'ordre", async () => {
    const file = await parseMp4(source("a-faststart.mp4"));
    const range = keptRangeAt(file, 0.2, 1, 0.1)!;
    expect(range.from).toBe(file.cues[0].clusterOffset);
    expect(range.to).toBe(file.cues[1].clusterOffset);
    expect(range.from).toBeLessThan(range.to);
  });
});

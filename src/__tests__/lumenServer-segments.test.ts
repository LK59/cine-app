import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { openMediaFile, createSampleReader } from "@/lib/webcodecs/mediaFile";
import { buildSegment, segmentSpec, audioSamples } from "@/lib/lumenServer/segment";
import { identityKey, SEQUENCE_STRIDE, type LumenIndex, type LumenRendition } from "@/lib/lumenServer/format";
import { runLumenJob } from "@/lib/lumenServer/jobs";
import type { MediaSample } from "@/lib/webcodecs/matroska";
import { endDecode, FIXTURES, fixtureIndex, parseFragments, type ParsedFragment } from "./lumenServer-helpers";

// Chaque segment de chaque fichier servi, produit **seul** — une source neuve, un en-tête relu —, puis
// recollé : c'est ce que fera un lecteur qui enchaîne, et ce qu'un saut défait. Trois propriétés, qui
// sont tout le contrat d'un HLS sans état (docs/remux-serveur/1-remuxeur.md §1.2) :
// 1. **chaque échantillon du fichier une fois et une seule**, ses octets intacts ;
// 2. **pas de trou ni de chevauchement** : le `tfdt` d'un segment est la fin de décodage du précédent
//    (règle 7.3 d'Apple), pour la vidéo comme pour le son ;
// 3. **déterministe** : deux constructions donnent les mêmes octets.
// La lecture par un vrai décodeur (ffmpeg) est le travail du banc `lumen-engine-bench.spec.ts`.

/** Ce que le lecteur du navigateur lit du fichier entier, piste par piste : la référence. */
async function referenceSamples(name: string, track: number): Promise<MediaSample[]> {
  const source = await FileByteSource.open(join(FIXTURES, name));
  try {
    const file = await openMediaFile(source);
    const reader = createSampleReader(source, file, file.firstClusterOffset ?? file.segmentDataStart);
    const out: MediaSample[] = [];
    for (;;) {
      const sample = await reader.next();
      if (!sample) break;
      if (sample.trackNumber === track) out.push({ ...sample, data: new Uint8Array(sample.data) });
    }
    return out;
  } finally {
    source.close();
  }
}

/** Chaque segment construit seul, sur sa propre source — comme deux requêtes, deux fils. */
async function allSegments(index: LumenIndex, rendition: LumenRendition): Promise<{ bytes: Uint8Array; fragments: ParsedFragment[] }[]> {
  const out = [];
  for (let n = 0; n < index.segments.length; n++) {
    const spec = segmentSpec(index, rendition, n);
    const source = await FileByteSource.open(spec.path);
    try {
      // Sans clé d'en-tête : rien n'est gardé d'une construction à l'autre.
      const file = await openMediaFile(source);
      const { bytes } = await buildSegment(source, file, spec);
      out.push({ bytes, fragments: parseFragments(bytes) });
    } finally {
      source.close();
    }
  }
  return out;
}

const SERVED = ["hevc-cra.mkv", "hevc-cra-sans-rasl.mkv", "hevc-idr.mkv", "h264-aac.mkv", "h264-opengop.mkv", "h264.mp4"];

describe.each(SERVED)("%s, segments produits seuls puis recollés", (name) => {
  it("la vidéo : chaque image une fois, à sa présentation + D, sans trou ni chevauchement", async () => {
    const { index, source } = await fixtureIndex(name, 1_000_000);
    source.close();
    expect(index.refusal).toBeNull();
    const video = index.video!;
    const segments = await allSegments(index, { kind: "video" });

    // Contiguïté : le tfdt de chaque segment est la fin de décodage du précédent.
    for (let n = 1; n < segments.length; n++) {
      expect([n, segments[n].fragments[0].baseDecode]).toEqual([n, endDecode(segments[n - 1].fragments)]);
    }
    // Numéros de fragment : N × 1000 + rang + 1, strictement croissants d'un segment à l'autre.
    const sequences = segments.flatMap((s, n) => s.fragments.map((f, r) => [f.sequence, n * SEQUENCE_STRIDE + r + 1]));
    for (const [written, expected] of sequences) expect(written).toBe(expected);
    // Chaque segment commence sur une image de synchronisation.
    for (const s of segments) expect(s.fragments[0].samples[0].flags).toBe(0x02000000);

    const produced = segments.flatMap((s) => s.fragments.flatMap((f) => f.samples.map((x, i) => ({ pts: x.decode + x.cto - index.delayUs, data: f.data[i], decode: x.decode }))));
    // Le décodage avance toujours, d'un segment à l'autre compris.
    for (let i = 1; i < produced.length; i++) expect(produced[i].decode).toBeGreaterThan(produced[i - 1].decode);

    const reference = await referenceSamples(name, video.number);
    expect(produced.map((p) => p.pts)).toEqual(reference.map((r) => r.timestampUs));
    produced.forEach((p, i) => expect(Buffer.compare(Buffer.from(p.data), Buffer.from(reference[i].data))).toBe(0));
  });

  it("le son : chaque trame une fois, contiguë d'un segment à l'autre, sur les mêmes frontières que la vidéo", async () => {
    const { index, source } = await fixtureIndex(name, 1_000_000);
    source.close();
    for (const track of index.audio.filter((a) => !a.refusal)) {
      const segments = await allSegments(index, { kind: "audio", track: track.number });
      for (let n = 1; n < segments.length; n++) {
        expect([track.number, n, segments[n].fragments[0].baseDecode]).toEqual([track.number, n, endDecode(segments[n - 1].fragments)]);
        // Le premier son du segment n est à sa frontière nominale (à une trame près).
        const first = segments[n].fragments[0].baseDecode - index.delayUs;
        expect(Math.abs(first - index.segments[n].startUs)).toBeLessThan(50_000);
      }
      const produced = segments.flatMap((s) => s.fragments.flatMap((f) => f.data));
      const reference = (await referenceSamples(name, track.number)).filter((r) => r.timestampUs + index.delayUs >= 0);
      expect(produced.length).toBe(reference.length);
      produced.forEach((p, i) => expect(Buffer.compare(Buffer.from(p), Buffer.from(reference[i].data))).toBe(0));
      for (const s of segments) for (const f of s.fragments) expect(f.trackId).toBe(2);
    }
  });

  it("deux constructions du même segment donnent les mêmes octets, par le travail d'un fil de calcul aussi", async () => {
    const { index, source } = await fixtureIndex(name, 1_000_000);
    source.close();
    const n = Math.min(1, index.segments.length - 1);
    const spec = segmentSpec(index, { kind: "video" }, n);
    const first = await runLumenJob({ type: "segment", spec });
    const second = await runLumenJob({ type: "segment", spec });
    if (first.type !== "segment" || second.type !== "segment") throw new Error("type");
    expect(Buffer.compare(Buffer.from(first.result.bytes), Buffer.from(second.result.bytes))).toBe(0);
    // Et l'index reconstruit par un fil de calcul est le même.
    const again = await runLumenJob({ type: "index", path: join(FIXTURES, name), targetUs: 1_000_000 });
    if (again.type !== "index") throw new Error("type");
    expect(again.index.segments).toEqual(index.segments);
    expect(again.index.delayUs).toBe(index.delayUs);
  });
});

describe("les frontières", () => {
  it("une CRA suivie de RASL n'ouvre jamais un segment ; une CRA sans RASL, si", async () => {
    const withRasl = await fixtureIndex("hevc-cra.mkv", 1_000_000);
    withRasl.source.close();
    expect(withRasl.index.keys.cra).toBeGreaterThan(0);
    expect(withRasl.index.keys.craRasl).toBe(withRasl.index.keys.cra);
    // Une seule IDR, en tête : un seul segment, ses RASL gardées à l'intérieur, avec leurs références.
    expect(withRasl.index.segments).toHaveLength(1);

    const without = await fixtureIndex("hevc-cra-sans-rasl.mkv", 1_000_000);
    without.source.close();
    expect(without.index.keys.cra).toBeGreaterThan(0);
    expect(without.index.keys.craRasl).toBe(0);
    expect(without.index.segments.length).toBe(without.index.keys.cuts);
  });

  it("une I H.264 suivie d'images de tête n'ouvre jamais un segment", async () => {
    const { index, source } = await fixtureIndex("h264-opengop.mkv", 1_000_000);
    source.close();
    expect(index.keys.leading).toBe(5);
    expect(index.keys.cuts).toBe(1);
    expect(index.segments).toHaveLength(1);
  });

  it("D est le même pour tout le fichier, et aucun décalage n'est borné", async () => {
    const { index, source } = await fixtureIndex("hevc-idr.mkv", 1_000_000);
    source.close();
    for (let n = 0; n < index.segments.length; n++) {
      const job = await runLumenJob({ type: "segment", spec: segmentSpec(index, { kind: "video" }, n) });
      if (job.type !== "segment") throw new Error("type");
      expect(job.result.facts.clamped).toBe(0);
    }
  });

  it("un fichier changé depuis son index ne produit rien", async () => {
    const { index, source } = await fixtureIndex("h264-aac.mkv", 1_000_000);
    source.close();
    const spec = { ...segmentSpec(index, { kind: "video" }, 0), key: identityKey({ ...index.identity, mtimeMs: index.identity.mtimeMs + 1 }) };
    await expect(runLumenJob({ type: "segment", spec })).rejects.toMatchObject({ code: "fichier-change" });
  });

  it("un segment ou une piste qui n'existe pas lève une erreur nette", async () => {
    const { index, source } = await fixtureIndex("hevc-cra.mkv", 1_000_000);
    source.close();
    expect(() => segmentSpec(index, { kind: "video" }, 99)).toThrow(expect.objectContaining({ code: "segment-inconnu" }));
    // La piste Opus est refusée : pas de segment pour elle.
    const opus = index.audio.find((a) => a.codecId === "A_OPUS")!;
    expect(() => segmentSpec(index, { kind: "audio", track: opus.number }, 0)).toThrow(expect.objectContaining({ code: "piste-inconnue" }));
  });
});

describe("audioSamples : la règle de buildAudio du remuxeur, et la fin mesurée sur le bloc suivant", () => {
  const frame = (t: number): MediaSample => ({ trackNumber: 2, timestampUs: t, durationUs: null, isKey: true, data: new Uint8Array([t & 0xff]) });

  it("des blocs lacés : la durée est l'écart au bloc suivant divisé par le nombre de trames", () => {
    const samples = audioSamples([frame(0), frame(0), frame(64_000), frame(64_000)], 128_000, 1000, null);
    expect(samples.map((s) => [s.decodeTime, s.duration])).toEqual([
      [1000, 32_000],
      [33_000, 32_000],
      [65_000, 32_000],
      [97_000, 32_000],
    ]);
  });

  it("la dernière série finit exactement sur le premier bloc du segment suivant", () => {
    const samples = audioSamples([frame(0), frame(21_333), frame(42_667)], 64_000, 0, null);
    const last = samples[samples.length - 1];
    expect(last.decodeTime + last.duration).toBe(64_000);
  });

  it("sans bloc suivant (fin du film) : la durée mesurée avant, sinon celle du codec", () => {
    expect(audioSamples([frame(0), frame(32_000)], null, 0, null).map((s) => s.duration)).toEqual([32_000, 32_000]);
    expect(audioSamples([frame(0)], null, 0, 21_333).map((s) => s.duration)).toEqual([21_333]);
  });

  it("une trame recouverte à plus de moitié est écartée (The Proposal), une trame avant l'origine aussi", () => {
    const samples = audioSamples([frame(0), frame(0), frame(40_000)], 72_000, 0, null);
    // 0 et 0 → 20 ms chacune (40/2) ; puis 40 → 72 : rien ne recule.
    expect(samples.map((s) => s.decodeTime)).toEqual([0, 20_000, 40_000]);
    expect(audioSamples([frame(-30_000), frame(0)], 30_000, 10_000, null).map((s) => s.decodeTime)).toEqual([10_000]);
  });
});

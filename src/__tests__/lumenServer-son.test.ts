import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { openMediaFile, createSampleReader } from "@/lib/webcodecs/mediaFile";
import { parseAacConfig } from "@/lib/webcodecs/mp4SampleEntries";
import { buildSegment, segmentSpec } from "@/lib/lumenServer/segment";
import { lumenEligibility } from "@/lib/lumenServer/eligibility";
import { masterPlaylist } from "@/lib/lumenServer/playlists";
import { aacHlsPlan, explicitSbrConfig, readAsc, readRawDataBlock, silenceMayFollow, silentAacFrame } from "@/lib/lumenServer/audio/aacStream";
import { BitWriter } from "@/lib/lumenServer/audio/bits";
import { ac3Crc, dolbyFrameCount, dolbySilenceRefusal, readDolbyHeader, silentDolbyFrame } from "@/lib/lumenServer/audio/dolbySilence";
import { nextSilentInstant, silentInstants, type LumenSilence } from "@/lib/lumenServer/audio/silence";
import type { LumenIndex } from "@/lib/lumenServer/format";
import type { MediaSample } from "@/lib/webcodecs/matroska";
import { endDecode, FIXTURES, fixtureIndex, parseFragments, type ParsedFragment } from "./lumenServer-helpers";

// Le son copié réparé (DECISIONS.md §159) : le SBR implicite rendu explicite sans toucher une trame, et le
// silence qui complète une piste devant ou derrière. Ce que ces tests prouvent sans décodeur : la syntaxe
// (configuration réécrite octet par octet, trames parcourues jusqu'à leur dernier bit, CRC des trames
// Dolby), la grille (chaque trame de silence une fois, au bon instant), et le contrat de §155 (chaque
// segment produit seul, recollé sans trou). Que ffmpeg décode ces trames en zéros exacts, que le son réel
// qui suit soit identique au bit, que les niveaux soient ceux de la source : le banc
// `lumen-son-bench.spec.ts`, sur de vrais fichiers.

const labels = { locale: "fr", canaux: (n: number) => `${n} canaux`, piste: (n: number) => `Piste ${n}` };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Toutes les trames d'une piste d'un fichier de test, dans l'ordre. */
async function trackFrames(name: string, track: number): Promise<MediaSample[]> {
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

/** Chaque segment son construit seul, sur sa propre source. */
async function audioSegments(index: LumenIndex, track: number): Promise<{ bytes: Uint8Array; fragments: ParsedFragment[] }[]> {
  const out = [];
  for (let n = 0; n < index.segments.length; n++) {
    const spec = segmentSpec(index, { kind: "audio", track }, n);
    const source = await FileByteSource.open(spec.path);
    try {
      const file = await openMediaFile(source);
      const { bytes } = await buildSegment(source, file, spec);
      out.push({ bytes, fragments: parseFragments(bytes) });
    } finally {
      source.close();
    }
  }
  return out;
}

/** Un FIL d'extension SBR (type 13) de `count` octets, inséré dans une trame à la position `at` (en bits). */
function withSbrFil(frame: Uint8Array, at: number, count = 6): Uint8Array {
  const w = new BitWriter();
  w.copy(frame, 0, at);
  w.write(6, 3).write(count, 4).write(13, 4); // FIL, count, EXT_SBR_DATA
  for (let i = 0; i < 8 * count - 4; i++) w.write(i % 3 === 0 ? 1 : 0, 1); // une charge quelconque
  // Le reste de la trame jusqu'à END compris, puis l'alignement.
  const block = readRawDataBlock(frame, 3);
  w.copy(frame, at, block.bits);
  return w.align().bytes();
}

describe("le SBR implicite", () => {
  it("la configuration réécrite en hiérarchique, octet par octet", () => {
    // AAC-LC 24 kHz stéréo (13 10) → type 5, 24 kHz, 2 canaux, extension 48 kHz, cœur LC : 2B 11 88 00 —
    // la forme qu'écrivent les encodeurs HE-AAC d'Apple et de Fraunhofer en signalisation hiérarchique.
    const stereo = readAsc(Uint8Array.of(0x13, 0x10))!;
    expect(stereo).toMatchObject({ objectType: 2, coreObjectType: 2, frequencyIndex: 6, channelConfiguration: 2, sbr: "non-dit" });
    expect(hex(explicitSbrConfig(stereo)!)).toBe("2b118800");
    // 5.1 à 24 kHz (13 30) → 2B 31 88 00 ; 22,05 kHz stéréo (13 90) → extension 44,1 kHz : 2B 92 08 00.
    expect(hex(explicitSbrConfig(readAsc(Uint8Array.of(0x13, 0x30))!)!)).toBe("2b318800");
    expect(hex(explicitSbrConfig(readAsc(Uint8Array.of(0x13, 0x90))!)!)).toBe("2b920800");
    // Relue par le lecteur de configurations de Laterna (celui de la liste) : HE-AAC, 48 kHz, 6 canaux.
    expect(parseAacConfig(explicitSbrConfig(readAsc(Uint8Array.of(0x13, 0x30))!)!)).toEqual({ objectType: 5, sampleRate: 48000, channels: 6 });
    // Un cœur à 48 kHz n'a pas d'extension dans la table : pas de réécriture.
    expect(explicitSbrConfig(readAsc(Uint8Array.of(0x11, 0x90))!)).toBeNull();
    // La forme rétrocompatible (extension de synchronisation 0x2B7) est lue pour ce qu'elle dit.
    expect(readAsc(Uint8Array.of(0x13, 0x10, 0x56, 0xe5, 0x98))).toMatchObject({ sbr: "synchro", extensionFrequencyIndex: 3 });
    expect(readAsc(Uint8Array.of(0x13, 0x10, 0x56, 0xe5, 0x00))).toMatchObject({ sbr: "absent" });
    expect(readAsc(Uint8Array.of(0x2b, 0x11, 0x88, 0x00))).toMatchObject({ objectType: 5, coreObjectType: 2, sbr: "hierarchique", extensionFrequencyIndex: 3 });
  });

  it("chaque trame AAC d'un vrai encodeur se parcourt jusqu'à son dernier bit, sans SBR", async () => {
    const frames = await trackFrames("h264-aac.mkv", 2);
    expect(frames.length).toBeGreaterThan(200);
    const { index, source } = await fixtureIndex("h264-aac.mkv");
    source.close();
    const config = readAsc(index.audio[0].codecPrivate!)!;
    for (const [i, f] of frames.entries()) {
      const block = readRawDataBlock(f.data, config.frequencyIndex);
      expect([i, block.exact, block.elements.map((e) => `${e.type}${e.sbr ? "+sbr" : ""}`).join()]).toEqual([i, true, "SCE"]);
    }
  });

  it("un FIL de données SBR derrière l'élément de canaux est trouvé ; la décision suit le flux, pas le nom", async () => {
    const frames = (await trackFrames("h264-aac.mkv", 2)).slice(0, 8).map((f) => f.data);
    const sbrFrames = frames.map((f) => withSbrFil(f, readRawDataBlock(f, 3).elements[0].endBit));
    for (const f of sbrFrames) {
      const block = readRawDataBlock(f, 3);
      expect(block.exact).toBe(true);
      expect(block.elements[0].sbr).toBe(true);
    }
    // La configuration de ces trames dit LC 48 kHz : pour l'essai, un cœur à 24 kHz (les bandes de 24 kHz
    // sont celles d'un autre indice ; on parcourt donc à l'indice 3 et on juge la décision sur une
    // configuration à l'indice 3 annonçant une extension double — 48 → 96 kHz n'existe pas : refus).
    const lc48 = Uint8Array.of(0x11, 0x90);
    expect(aacHlsPlan(lc48, frames, 48000)).toMatchObject({ kind: "copie" });
    expect(aacHlsPlan(lc48, sbrFrames, 48000)).toMatchObject({ kind: "refus", reason: "son-aac-sbr-implicite", detail: "cœur à 48000 Hz" });
    // Trames en désaccord : refus.
    expect(aacHlsPlan(lc48, [sbrFrames[0], frames[1]], 48000)).toMatchObject({ kind: "refus", detail: "trames en désaccord sur le SBR" });
    // Le conteneur annonce le double, le flux n'a pas de SBR : contradiction, refus.
    expect(aacHlsPlan(lc48, frames, 96000)).toMatchObject({ kind: "refus", detail: "aucun SBR dans le flux, fréquence double annoncée" });
  });

  it("silence SBR synthétique à 24 kHz : réécrit en stéréo, refusé en mono (stéréo paramétrique possible)", () => {
    // Des trames silencieuses d'un cœur à 24 kHz, un FIL SBR derrière chaque élément de canaux.
    const sbrFrame = (config: number) => {
      const silent = silentAacFrame(config)!;
      const block = readRawDataBlock(silent, 6);
      let frame = silent;
      // De la fin vers le début, pour que les positions restent justes.
      for (const e of [...block.elements].reverse()) if (e.type !== "LFE") frame = withSbrFilAt(frame, e.endBit);
      return frame;
    };
    const withSbrFilAt = (frame: Uint8Array, at: number) => {
      const end = readRawDataBlock(frame, 6).bits;
      const w = new BitWriter().copy(frame, 0, at).write(6, 3).write(3, 4).write(13, 4).write(0, 20).copy(frame, at, end);
      return w.align().bytes();
    };
    const stereo = aacHlsPlan(Uint8Array.of(0x13, 0x10), [sbrFrame(2), sbrFrame(2)], 48000);
    expect(stereo).toMatchObject({ kind: "sbr-explicite", sampleRate: 48000, channels: 2 });
    expect(hex((stereo as { configuration: Uint8Array }).configuration)).toBe("2b118800");
    const surround = aacHlsPlan(Uint8Array.of(0x13, 0x30), [sbrFrame(6)], 24000);
    // Le conteneur ne disait rien (24 kHz) : le flux suffit, et la réécriture a lieu quand même.
    expect(surround).toMatchObject({ kind: "sbr-explicite", sampleRate: 48000, channels: 6 });
    expect(aacHlsPlan(Uint8Array.of(0x13, 0x08), [sbrFrame(1)], 48000)).toMatchObject({ kind: "refus", reason: "son-aac-ps-implicite" });
    // La signalisation rétrocompatible (13 10 56 E5 98, celle des cinq fichiers HE-AAC du banc) : le SBR est
    // vérifié dans le flux, puis la configuration passe en hiérarchique comme une implicite.
    const backward = Uint8Array.of(0x13, 0x10, 0x56, 0xe5, 0x98);
    expect(hex((aacHlsPlan(backward, [sbrFrame(2)], 48000) as { configuration: Uint8Array }).configuration)).toBe("2b118800");
    expect(aacHlsPlan(backward, [silentAacFrame(2)!], 48000)).toMatchObject({ kind: "refus", detail: "aucun SBR dans le flux, fréquence double annoncée" });
    // Un flux illisible : refusé si le conteneur annonçait un HE-AAC, copié comme avant sinon.
    const garbage = Uint8Array.of(0xff, 0xff, 0xff);
    expect(aacHlsPlan(Uint8Array.of(0x13, 0x10), [garbage], 48000)).toMatchObject({ kind: "refus", reason: "son-aac-sbr-implicite" });
    expect(aacHlsPlan(Uint8Array.of(0x13, 0x10), [garbage], 24000)).toMatchObject({ kind: "copie" });
    // Déjà hiérarchique : copié tel quel, sans lire le flux.
    expect(aacHlsPlan(Uint8Array.of(0x2b, 0x11, 0x88, 0x00), [garbage], 48000)).toMatchObject({ kind: "copie" });
  });
});

describe("les trames de silence", () => {
  it("AAC-LC : chaque configuration 1 à 7 se parcourt exactement, sans bande", () => {
    expect(hex(silentAacFrame(2)!)).toBe("21000320641c"); // CPE commun, deux canaux vides, END
    for (let config = 1; config <= 7; config++) {
      const frame = silentAacFrame(config)!;
      const block = readRawDataBlock(frame, 3);
      expect(block.exact).toBe(true);
      expect(block.elements.every((e) => e.windowSequences.every((s) => s === 0))).toBe(true);
      expect(silenceMayFollow(frame, 3)).toBe(true);
    }
    expect(silentAacFrame(0)).toBeNull();
  });

  it("AC-3 et E-AC-3 : le CRC des vraies trames est nul ; la trame de silence garde l'en-tête bit pour bit et la taille", async () => {
    const cases: [string, number, "ac3" | "eac3", number][] = [
      ["ac3-late.mkv", 2, "ac3", 7],
      ["ac3-short.mkv", 2, "ac3", 2],
      ["ac3-32k.mkv", 2, "ac3", 1],
      ["eac3-late.mkv", 2, "eac3", 7],
      ["eac3-short.mkv", 2, "eac3", 2],
      ["hevc-cra.mkv", 3, "ac3", 7],
    ];
    for (const [name, track, kind, acmod] of cases) {
      const [first] = await trackFrames(name, track);
      const head = readDolbyHeader(first.data)!;
      expect([name, head.kind, head.acmod, head.frameSize]).toEqual([name, kind, acmod, first.data.length]);
      // Le CRC d'une trame entière (après la synchronisation) est nul : l'implémentation est celle d'A/52.
      expect(ac3Crc(first.data, 2)).toBe(0);
      if (kind === "ac3") expect(ac3Crc(first.data, 2, ((head.frameSize >> 2) + (head.frameSize >> 4)) << 1)).toBe(0);
      expect(dolbySilenceRefusal(first.data)).toBeNull();
      const silent = silentDolbyFrame(first.data)!;
      expect(silent.length).toBe(first.data.length);
      expect(ac3Crc(silent, 2)).toBe(0);
      if (kind === "ac3") expect(ac3Crc(silent, 2, ((head.frameSize >> 2) + (head.frameSize >> 4)) << 1)).toBe(0);
      // L'en-tête (hors crc1, recalculé) est celui de la piste.
      const from = kind === "ac3" ? 32 : 16;
      const bitsOf = (b: Uint8Array) => Array.from({ length: head.bsiEnd - from }, (_, i) => (b[(from + i) >> 3] >> (7 - ((from + i) & 7))) & 1).join("");
      expect(bitsOf(silent)).toBe(bitsOf(first.data));
      expect(readDolbyHeader(silent)).toEqual(head);
      // Déterministe.
      expect(hex(silentDolbyFrame(first.data)!)).toBe(hex(silent));
    }
  });

  it("refuse ce qu'il ne construit pas : sous-flux dépendant, Atmos, trame illisible", async () => {
    const [eac3] = await trackFrames("eac3-short.mkv", 2);
    const dependent = new Uint8Array(eac3.data.length * 2);
    dependent.set(eac3.data);
    dependent.set(eac3.data, eac3.data.length);
    expect(dolbySilenceRefusal(dependent)).toBe("E-AC-3 à sous-flux dépendant");
    expect(dolbySilenceRefusal(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7))).toBe("trame illisible");
    // Deux trames AC-3 à la suite dans un échantillon : deux trames de durée (la fin du son derrière en dépend).
    const [ac3] = await trackFrames("ac3-short.mkv", 2);
    const two = new Uint8Array(ac3.data.length * 2);
    two.set(ac3.data);
    two.set(ac3.data, ac3.data.length);
    expect(dolbyFrameCount(ac3.data)).toBe(1);
    expect(dolbyFrameCount(two)).toBe(2);
    expect(dolbyFrameCount(two.subarray(0, ac3.data.length + 3))).toBeNull();
  });
});

describe("la grille du silence", () => {
  const lead: LumenSilence = { frame: Uint8Array.of(0), frameUs: 32_000, leadUntilUs: 3_008_000, tailFromUs: null, endUs: 6_000_000 };
  const tail: LumenSilence = { frame: Uint8Array.of(0), frameUs: 1024e6 / 44100, leadUntilUs: null, tailFromUs: 2_021_000, endUs: 6_000_000 };

  it("devant : de 0 ou juste avant jusqu'au premier bloc, une trame par pas ; derrière : de la fin jusqu'au bout du film", () => {
    const all = silentInstants(lead, -Infinity, Infinity);
    expect(all[0]).toBeLessThanOrEqual(0);
    expect(all[0]).toBeGreaterThan(-32_000);
    expect(all[all.length - 1] + 32_000).toBeCloseTo(3_008_000, 6);
    expect(all.length).toBe(94);
    const end = silentInstants(tail, -Infinity, Infinity);
    expect(end[0]).toBe(2_021_000);
    expect(end[end.length - 1]).toBeLessThan(6_000_000);
    expect(end[end.length - 1] + tail.frameUs).toBeGreaterThanOrEqual(6_000_000);
  });

  it("des segments voisins se partagent les trames : chacune une fois, et la suivante est celle du segment d'après", () => {
    for (const s of [lead, tail]) {
      const all = silentInstants(s, -Infinity, Infinity);
      const bounds = [-Infinity, 777_777, 1_000_000, 2_021_000, 2_500_001, 3_008_000, 4_000_000, Infinity];
      const parts = bounds.slice(1).map((upper, i) => silentInstants(s, bounds[i], upper));
      expect(parts.flat()).toEqual(all);
      parts.forEach((part, i) => {
        if (i + 1 >= parts.length) return;
        const following = parts.slice(i + 1).flat()[0] ?? null;
        expect(nextSilentInstant(s, bounds[i + 1])).toBe(following);
      });
    }
  });
});

describe("les pistes réparées, servies", () => {
  const files: [string, "silence-devant" | "silence-derriere"][] = [
    ["h264-late.mkv", "silence-devant"],
    ["ac3-late.mkv", "silence-devant"],
    ["eac3-late.mkv", "silence-devant"],
    ["h264-short.mkv", "silence-derriere"],
    ["ac3-short.mkv", "silence-derriere"],
    ["eac3-short.mkv", "silence-derriere"],
  ];

  it.each(files)("%s : servie, chaque segment seul, recollé sans trou, du début de l'image à sa fin", async (name, kind) => {
    const { index, source } = await fixtureIndex(name, 1_000_000);
    source.close();
    const track = index.audio[0];
    expect(lumenEligibility(index, track.number)).toEqual({ ok: true });
    expect(track.silence).toBeTruthy();
    expect(kind === "silence-devant" ? track.silence!.leadUntilUs : track.silence!.tailFromUs).not.toBeNull();
    expect(masterPlaylist(index, { audioTrack: track.number, labels })).toContain(`URI="a${track.number}.m3u8"`);

    const segments = await audioSegments(index, track.number);
    for (let n = 1; n < segments.length; n++) expect([n, segments[n].fragments[0].baseDecode]).toEqual([n, endDecode(segments[n - 1].fragments)]);
    const samples = segments.flatMap((s) => s.fragments.flatMap((f) => f.samples.map((x, i) => ({ decode: x.decode, duration: x.duration, data: f.data[i] }))));
    // Le son couvre l'image : il commence au plus une trame après D (le premier instant), finit au plus une
    // trame avant la fin du film.
    const frameUs = track.silence!.frameUs;
    expect(samples[0].decode - index.delayUs).toBeLessThanOrEqual(frameUs);
    const last = samples[samples.length - 1];
    expect(last.decode + last.duration - index.delayUs).toBeGreaterThan(index.durationUs - frameUs);
    // Les trames réelles, toutes, octets intacts et dans l'ordre ; les autres sont la trame de silence.
    const real = await trackFrames(name, track.number);
    const silent = hex(track.silence!.frame);
    const served = samples.filter((s) => hex(s.data) !== silent).map((s) => hex(s.data));
    expect(served).toEqual(real.map((f) => hex(f.data)).filter((h) => h !== silent));
    // La trame de silence tient sa place sur la grille : durée d'une trame, à l'arrondi de la µs.
    for (const s of samples) if (hex(s.data) === silent) expect(Math.abs(s.duration - frameUs)).toBeLessThanOrEqual(1);
    // Déterministe : un segment reconstruit donne les mêmes octets.
    const again = await audioSegments(index, track.number);
    expect(again.map((s) => hex(s.bytes))).toEqual(segments.map((s) => hex(s.bytes)));
  });

  it("une piste qui couvre l'image n'a ni silence ni configuration : ses segments sont ceux d'avant", async () => {
    const { index, source } = await fixtureIndex("hevc-cra.mkv");
    source.close();
    for (const a of index.audio) {
      expect(a.silence).toBeUndefined();
      expect(a.configuration).toBeUndefined();
      if (!a.refusal) expect(segmentSpec(index, { kind: "audio", track: a.number }, 0).audio).not.toHaveProperty("silence");
    }
  });

  it("l'AC-3 à 32 kHz est servi, son init dit 32 kHz", async () => {
    const { index, source } = await fixtureIndex("ac3-32k.mkv");
    source.close();
    expect(lumenEligibility(index, index.audio[0].number)).toEqual({ ok: true });
    expect(index.audio[0].sampleRate).toBe(32000);
  });
});

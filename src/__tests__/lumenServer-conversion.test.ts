import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// La conversion du son de Lumen serveur (DECISIONS.md §161 à §163), sans ffmpeg : la grille, le placement par le
// nombre d'échantillons, le flux donné à ffmpeg, ses arguments (aucun chemin, jamais de shell), l'Ogg de l'Opus, le
// cache en deux étages, la file et ses priorités, l'avance, l'admission. Ce qui demande ffmpeg (octets produits,
// jointures, niveaux, placement contre la source) est au banc `lumen-audio-bench.spec.ts`.

import {
  EAC3_FRAME,
  ENCODER_DELAY,
  ENCODER_PREROLL,
  ENCODER_TAIL,
  DECODER_PREROLL,
  frameDecodeUs,
  inputWindow,
  outputRank,
  panFor,
  segmentFrames,
  targetFor,
  targetTag,
  TARGET_20,
  TARGET_51,
} from "@/lib/lumenServer/audio/convertGrid";
import {
  concatUnits,
  convertSourceOf,
  dtsFrameSamples,
  FeedError,
  mpegFrameSamples,
  opusPacketSamples,
  opusPreSkip,
  planFeed,
  truehdUnits,
  unitPosition,
  type LumenConvertSource,
  type SourceBlock,
} from "@/lib/lumenServer/audio/convertSource";
import { oggCrc, oggOpus, zeroPreSkip } from "@/lib/lumenServer/audio/ogg";
import { conversionArgs, windowIsSilent, windowOf } from "@/lib/lumenServer/audio/convert";
import { parseFfmpegList, parseFfmpegVersion, runFfmpeg, splitEac3Frames, FfmpegError, checkTargetFrame } from "@/lib/lumenServer/audio/ffmpeg";
import { DiskTier, envelope, MemoryTier, openEnvelope, relativePathOf, keyString } from "@/lib/lumenServer/audio/convertCache";
import { AudioQueue } from "@/lib/lumenServer/audio/conversion";
import { parseLumenPath, renditionTag } from "@/lib/lumenServer/format";

const segs = (starts: number[], end: number) => ({
  durationUs: end,
  segments: starts.map((s, i) => ({ startUs: s, endUs: starts[i + 1] ?? end, keyUs: s, at: i, bytes: 0 })),
});

describe("la grille des trames cibles", () => {
  it("une trame appartient au segment qui contient son instant ; le premier part de 0, le dernier finit à l'image", () => {
    const index = segs([0, 4_004_000, 8_008_000], 10_000_000);
    expect(segmentFrames(index, 0)).toEqual([0, 126]); // 126 × 32 ms = 4,032 s ≥ 4,004 s
    expect(segmentFrames(index, 1)).toEqual([126, 251]);
    expect(segmentFrames(index, 2)).toEqual([251, 313]);
    expect(segmentFrames(index, 0, 3)).toEqual([0, 313]);
    // Contiguës : chaque trame dans un seul segment.
    expect(segmentFrames(index, 0)[1]).toBe(segmentFrames(index, 1)[0]);
  });

  it("la fenêtre de l'encodeur : pré-roulement, délai, queue ; tfdt = k × 32 000 µs + D", () => {
    const w = inputWindow(126, 251);
    expect(w.start).toBe((126 - ENCODER_PREROLL) * EAC3_FRAME + ENCODER_DELAY);
    expect(w.end).toBe((251 + ENCODER_TAIL) * EAC3_FRAME + ENCODER_DELAY);
    expect(outputRank(126, 126)).toBe(ENCODER_PREROLL);
    expect(frameDecodeUs(126, 83_000)).toBe(126 * 32_000 + 83_000);
  });

  it("la cible : 5.1 à 640 kb/s pour trois canaux et plus, 2.0 à 256 kb/s sinon ; ses réglages dans son nom", () => {
    expect([1, 2, 3, 6, 7, 8].map((c) => targetFor(c).id)).toEqual(["eac3-256-20", "eac3-256-20", "eac3-640-51", "eac3-640-51", "eac3-640-51", "eac3-640-51"]);
    expect(targetTag(TARGET_51)).toBe(`eac3-640-51-p${ENCODER_PREROLL}`);
  });

  it("le repli suit la règle de `fold` : 7.1 → 5.1 à −3 dB, dispositions inconnues réduites à L R C, mono dans les deux", () => {
    expect(panFor(8, TARGET_51)).toBe("pan=5.1(side)|c0=c0|c1=c1|c2=c2|c3=c3|c4=0.7071067811865476*c4+0.7071067811865476*c6|c5=0.7071067811865476*c5+0.7071067811865476*c7");
    expect(String(Math.SQRT1_2)).toBe("0.7071067811865476");
    expect(panFor(6, TARGET_51)).toBe("pan=5.1(side)|c0=c0|c1=c1|c2=c2|c3=c3|c4=c4|c5=c5");
    for (const c of [3, 4, 5, 7]) expect(panFor(c, TARGET_51)).toBe("pan=5.1(side)|c0=c0|c1=c1|c2=c2");
    expect(panFor(2, TARGET_20)).toBe("pan=stereo|c0=c0|c1=c1");
    expect(panFor(1, TARGET_20)).toBe("pan=stereo|c0=c0|c1=c0");
  });
});

describe("les unités des codecs sources", () => {
  it("Opus : la durée d'un paquet lue dans son octet TOC", () => {
    expect(opusPacketSamples(Uint8Array.of((31 << 3) | 0))).toBe(960); // CELT 20 ms
    expect(opusPacketSamples(Uint8Array.of((16 << 3) | 0))).toBe(120); // CELT 2,5 ms
    expect(opusPacketSamples(Uint8Array.of((1 << 3) | 1))).toBe(1920); // SILK 20 ms × 2
    expect(opusPacketSamples(Uint8Array.of((3 << 3) | 3, 3))).toBe(8640 > 5760 ? null : 8640); // 60 ms × 3 : trop long
    expect(opusPacketSamples(Uint8Array.of((19 << 3) | 3, 2))).toBe(1920); // CELT 20 ms × 2
    expect(opusPacketSamples(new Uint8Array(0))).toBeNull();
  });

  it("DTS : NBLKS du cœur ; un flux sans cœur n'est pas pris", () => {
    // SYNC 7FFE8001, FTYPE 1, SHORT 31, CPF 0, NBLKS 15 → 16 × 32 = 512.
    const core = Uint8Array.of(0x7f, 0xfe, 0x80, 0x01, 0xfc, 0x3c, 0, 0);
    expect(dtsFrameSamples(core)).toBe(512);
    expect(dtsFrameSamples(Uint8Array.of(0x64, 0x58, 0x20, 0x25, 0, 0, 0, 0))).toBeNull();
  });

  it("MPEG : 1 152 échantillons en couche II ou III MPEG-1, rien d'autre", () => {
    expect(mpegFrameSamples(Uint8Array.of(0xff, 0xfd, 0x90, 0x00))).toBe(1152); // MPEG-1 couche II
    expect(mpegFrameSamples(Uint8Array.of(0xff, 0xfb, 0x90, 0x00))).toBe(1152); // MPEG-1 couche III
    expect(mpegFrameSamples(Uint8Array.of(0xff, 0xf3, 0x90, 0x00))).toBeNull(); // MPEG-2 couche III (576)
  });

  it("TrueHD : les unités d'accès collées d'une trame, leur compteur, leur synchronisation majeure", () => {
    const au = (len: number, timing: number, sync: boolean) => {
      const b = new Uint8Array(len);
      b[0] = (len / 2) >> 8;
      b[1] = (len / 2) & 0xff;
      b[2] = timing >> 8;
      b[3] = timing & 0xff;
      if (sync) b.set([0xf8, 0x72, 0x6f, 0xba], 4);
      return b;
    };
    const frame = new Uint8Array([...au(32, 100, true), ...au(16, 140, false)]);
    const units = truehdUnits(frame)!;
    expect(units.map((u) => [u.data.length, u.timing, u.sync, u.samples])).toEqual([
      [32, 100, true, 40],
      [16, 140, false, 40],
    ]);
    expect(truehdUnits(frame.subarray(0, 40))).toBeNull(); // une unité coupée
  });
});

/** Une piste TrueHD dont le compteur prend du retard avant chaque synchronisation, comme *Braveheart*. */
function truehdSource(): LumenConvertSource {
  return { codec: "truehd", channels: 8, grid: 40, firstUs: 0, firstSample: 0, timing0: 48085, opusHead: null, quietFromUs: null };
}

describe("le placement par le nombre d'échantillons", () => {
  it("DTS : l'arrondi de l'instant du bloc sur la grille de la trame, ancrée au premier bloc", () => {
    const source: LumenConvertSource = { codec: "dts", channels: 6, grid: 512, firstUs: 4000, firstSample: 192, timing0: null, opusHead: null, quietFromUs: null };
    const unit = { data: new Uint8Array(0), samples: 512, sync: true };
    // Instants à la milliseconde : 10,667 ms → 11 ms ; l'arrondi retombe sur la trame juste.
    expect(unitPosition(source, 4000 + 11_000, unit, 0)).toBe(192 + 512);
    expect(unitPosition(source, 4000 + 21_000, unit, 0)).toBe(192 + 1024);
    expect(unitPosition(source, 4000 + 32_000, unit, 0)).toBe(192 + 1536);
    expect(unitPosition(source, 4000 + 32_000, unit, 512)).toBe(192 + 2048); // la trame suivante du même bloc
  });

  it("TrueHD : une synchronisation majeure tombe sur son multiple de 40, quel que soit le retard du compteur", () => {
    const s = truehdSource();
    // L'unité 128, synchronisation, compteur en retard de 36 (relevé) et instant du bloc 55 ms en avance.
    const sync128 = { data: new Uint8Array(0), samples: 40, sync: true, timing: (48085 + 35 + 128 * 40 - 36) % 65536 };
    expect(unitPosition(s, 107_000 + 55_000, sync128, 0)).toBe(128 * 40);
    // Au-delà d'un tour de modulo (65 536) : l'instant choisit le tour.
    const far = { data: new Uint8Array(0), samples: 40, sync: true, timing: (48085 + 2000 * 40) % 65536 };
    expect(unitPosition(s, (2000 * 40 * 1e6) / 48000, far, 0)).toBe(2000 * 40);
  });

  it("le flux d'une fenêtre : depuis la dernière unité d'où l'on repart, 0,25 s avant ; positions par bloc", () => {
    const source: LumenConvertSource = { codec: "mpeg", channels: 2, grid: 1152, firstUs: 0, firstSample: 0, timing0: null, opusHead: null, quietFromUs: null };
    const frame = Uint8Array.of(0xff, 0xfd, 0x90, 0x00);
    const blocks: SourceBlock[] = Array.from({ length: 100 }, (_, i) => ({ timeUs: i * 24_000, frames: [frame] }));
    const feed = planFeed(source, blocks, 48_000, 96_000)!;
    // La dernière trame placée au plus à 48 000 − 12 000 = 36 000 : 31 × 1 152 = 35 712.
    expect(feed.startSample).toBe(31 * 1152);
    expect(feed.units.length).toBe(Math.ceil(96_000 / 1152) - 31);
    expect(concatUnits(feed.units).length).toBe(feed.units.length * 4);
    // Au début de la piste : la première unité, sans pré-roulement possible.
    expect(planFeed(source, blocks, 1000, 5000)!.startSample).toBe(0);
    // Une lecture qui ne remonte pas assez : une erreur nette, la lecture repart plus tôt (`retryAt`).
    expect(() => planFeed(source, blocks.slice(40), 48_000, 96_000)).toThrow(FeedError);
    // Une fenêtre sans unité : null (le silence).
    expect(planFeed(source, blocks.slice(0, 2), 400_000, 500_000)).toBeNull();
  });

  it("les faits de l'index : 48 kHz et Matroska seulement ; l'Opus garde son pre-skip, le TrueHD son compteur", () => {
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode("OpusHead"));
    head[8] = 1;
    head[9] = 2;
    head[10] = 0x38; // 312
    head[11] = 0x01;
    expect(opusPreSkip(head)).toBe(312);
    const opus = convertSourceOf({ codecId: "A_OPUS", codecPrivate: head, channels: 2, sampleRate: 48000 }, { firstUs: 0, firstFrame: Uint8Array.of(31 << 3), lastBlockUs: 30_000_000 }, "matroska");
    expect(opus).toMatchObject({ ok: true, source: { codec: "opus", grid: 120, firstSample: -312, quietFromUs: 31_000_000 } });
    expect(convertSourceOf({ codecId: "A_DTS", codecPrivate: null, channels: 6, sampleRate: 96000 }, { firstUs: 0, firstFrame: null, lastBlockUs: null }, "matroska")).toMatchObject({ ok: false });
    expect(convertSourceOf({ codecId: "A_DTS", codecPrivate: null, channels: 6, sampleRate: 48000 }, { firstUs: 0, firstFrame: null, lastBlockUs: null }, "mp4")).toMatchObject({ ok: false });
    expect(convertSourceOf({ codecId: "A_AC3", codecPrivate: null, channels: 6, sampleRate: 48000 }, { firstUs: 0, firstFrame: null, lastBlockUs: null }, "matroska")).toMatchObject({ ok: false });
  });
});

describe("ffmpeg : les arguments, le lancement, la sortie", () => {
  const w = windowOf(segs([0, 4_004_000], 8_000_000), 1, 2);

  it("aucun chemin de fichier : l'entrée et la sortie sont des tubes, et seul `pipe` est permis", () => {
    for (const feed of [null, { format: "dts", startSample: w.start - 13_000 }, { format: "truehd", startSample: w.start + 4_000 }]) {
      const args = conversionArgs(feed, w, 6, TARGET_51);
      expect(args).toContain("-protocol_whitelist");
      expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("pipe");
      expect(args.filter((a) => a.startsWith("pipe:"))).toEqual(["pipe:0", "pipe:1"]);
      expect(args.some((a) => a.includes("/"))).toBe(false);
    }
  });

  it("la fenêtre placée à l'échantillon : `atrim` devant, `adelay` si le son commence dedans, `apad` et `atrim` derrière", () => {
    const length = w.end - w.start;
    const before = conversionArgs({ format: "dts", startSample: w.start - 13_000 }, w, 6, TARGET_51);
    expect(before[before.indexOf("-af") + 1]).toBe(`atrim=start_sample=13000,${panFor(6, TARGET_51)},apad=whole_len=${length},atrim=end_sample=${length}`);
    const late = conversionArgs({ format: "dts", startSample: w.start + 4_000 }, w, 6, TARGET_51);
    expect(late[late.indexOf("-af") + 1]).toBe(`${panFor(6, TARGET_51)},adelay=delays=4000S:all=1,apad=whole_len=${length},atrim=end_sample=${length}`);
    const silent = conversionArgs(null, w, 6, TARGET_51);
    expect(silent.slice(silent.indexOf("-f"), silent.indexOf("-i"))).toEqual(["-f", "f32le", "-ar", "48000", "-ch_layout", "5.1(side)"]);
  });

  it("une fenêtre entièrement avant le premier son ou après la fin sûre ne lit rien", () => {
    const src: LumenConvertSource = { codec: "dts", channels: 6, grid: 512, firstUs: 30_000_000, firstSample: 1_440_000, timing0: null, opusHead: null, quietFromUs: 6_000_000_000 };
    expect(windowIsSilent(src, w)).toBe(true);
    expect(windowIsSilent({ ...src, firstUs: 0, firstSample: 0, quietFromUs: 1_000_000 }, w)).toBe(true);
    expect(windowIsSilent({ ...src, firstUs: 0, firstSample: 0, quietFromUs: null }, w)).toBe(false);
  });

  it("lance le programme sans shell, avec un environnement vide, et le tue au-delà de son délai", async () => {
    const echo = await runFfmpeg(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], Uint8Array.of(1, 2, 3), { timeoutMs: 10_000 });
    expect([...echo.stdout]).toEqual([1, 2, 3]);
    // Un argument qui serait interprété par un shell reste un argument.
    const literal = await runFfmpeg(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "$(echo injecté);ls"], null, { timeoutMs: 10_000 });
    expect(new TextDecoder().decode(literal.stdout)).toBe("$(echo injecté);ls");
    const env = await runFfmpeg(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /KEY|SECRET|TOKEN|URL/.test(k))))"], null, { timeoutMs: 10_000 });
    expect(JSON.parse(new TextDecoder().decode(env.stdout))).toEqual([]);
    await expect(runFfmpeg(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], null, { timeoutMs: 200 })).rejects.toMatchObject({ kind: "timeout" });
    const controller = new AbortController();
    const pending = runFfmpeg(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], null, { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(FfmpegError);
    await expect(runFfmpeg(process.execPath, ["-e", "process.exit(3)"], null, { timeoutMs: 10_000 })).rejects.toMatchObject({ kind: "exit" });
  });

  it("lit la version et les listes de ffmpeg", () => {
    expect(parseFfmpegVersion("ffmpeg version 7.1.5 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc")).toBe("7.1.5");
    expect([...parseFfmpegList(" V..... = Video\n ------\n A....D aac   AAC\n A....D eac3  ATSC A/52 E-AC-3\n", "codec")]).toEqual(["aac", "eac3"]);
    expect([...parseFfmpegList(" D.. = Demuxing supported\n ---\n D   dts   raw DTS\n D   f32le PCM\n DE  mov,mp4,m4a  QuickTime\n", "format")]).toEqual(["dts", "f32le", "mov", "mp4", "m4a"]);
    expect([...parseFfmpegList("  T.. = Timeline support\n T.C adelay  A->A  Delay\n ... pan   A->A  Remix\n", "filter")]).toEqual(["adelay", "pan"]);
  });

  it("découpe un flux E-AC-3 brut exactement, et refuse une trame qui n'est pas la cible", () => {
    const frame = new Uint8Array(8);
    frame.set([0x0b, 0x77, 0x00, 0x03]); // frmsiz 3 → 8 octets
    expect(splitEac3Frames(new Uint8Array([...frame, ...frame])).length).toBe(2);
    expect(() => splitEac3Frames(new Uint8Array([...frame, 0x0b]))).toThrow();
    expect(checkTargetFrame(frame, TARGET_51)).not.toBeNull();
    expect(checkTargetFrame(null, TARGET_51)).toBe("aucune trame");
  });
});

describe("l'Ogg Opus donné à ffmpeg", () => {
  it("CRC de l'Ogg, en-tête recopié pre-skip à zéro, une page par paquet, positions exactes", () => {
    expect(oggCrc(new TextEncoder().encode("OggS"))).toBe(0x5fb0a94f);
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode("OpusHead"));
    head[9] = 2;
    head[10] = 0x38;
    head[11] = 0x01;
    expect([...zeroPreSkip(head).subarray(10, 12)]).toEqual([0, 0]);
    expect(head[10]).toBe(0x38); // l'original intact
    const packets = [{ data: new Uint8Array(300).fill(7), samples: 960 }, { data: Uint8Array.of(1), samples: 960 }];
    const ogg = oggOpus(head, packets);
    const pages: { granule: bigint; flags: number; size: number }[] = [];
    for (let at = 0; at < ogg.length; ) {
      expect(String.fromCharCode(...ogg.subarray(at, at + 4))).toBe("OggS");
      const view = new DataView(ogg.buffer, ogg.byteOffset + at);
      const segments = ogg[at + 26];
      const size = ogg.subarray(at + 27, at + 27 + segments).reduce((a, b) => a + b, 0);
      // Le CRC de chaque page, recalculé champ à zéro.
      const copy = ogg.slice(at, at + 27 + segments + size);
      const crc = new DataView(copy.buffer).getUint32(22, true);
      copy.fill(0, 22, 26);
      expect(oggCrc(copy)).toBe(crc);
      pages.push({ granule: view.getBigInt64(6, true), flags: ogg[at + 5], size });
      at += 27 + segments + size;
    }
    expect(pages.map((p) => [Number(p.granule), p.flags, p.size])).toEqual([
      [0, 2, 19],
      [0, 0, 25],
      [960, 0, 300],
      [1920, 4, 1],
    ]);
  });
});

describe("le cache en deux étages", () => {
  it("l'enveloppe : un fichier tronqué, corrompu ou étranger se lit comme une absence", () => {
    const body = Uint8Array.of(1, 2, 3, 4, 5);
    const env = envelope(body);
    expect([...openEnvelope(env)!]).toEqual([1, 2, 3, 4, 5]);
    expect(openEnvelope(env.subarray(0, env.length - 1))).toBeNull();
    const bad = env.slice();
    bad[bad.length - 1] ^= 1;
    expect(openEnvelope(bad)).toBeNull();
    expect(openEnvelope(Uint8Array.of(0, 1, 2))).toBeNull();
  });

  it("la clé porte tout ce qui fixe les octets, et rien d'autre ne passe dans un chemin", () => {
    const key = { version: "4-0123456789ab", track: 3, target: targetTag(TARGET_51), cid: "1a2b3c4d", n: 12 };
    expect(keyString(key)).toBe(`4-0123456789ab/3-${targetTag(TARGET_51)}-1a2b3c4d/12`);
    expect(relativePathOf(key)).toBe(join("4-0123456789ab", `3-${targetTag(TARGET_51)}-1a2b3c4d`, "12.seg"));
    expect(relativePathOf({ ...key, version: "../../etc" })).toBeNull();
    expect(relativePathOf({ ...key, n: -1 })).toBeNull();
  });

  it("en mémoire : le moins récemment lu part le premier, sous le plafond", () => {
    const tier = new MemoryTier(() => 10);
    tier.put("a", new Uint8Array(4));
    tier.put("b", new Uint8Array(4));
    expect(tier.get("a")).not.toBeNull(); // relu : « b » devient le plus ancien
    tier.put("c", new Uint8Array(4));
    expect(tier.has("b")).toBe(false);
    expect(tier.has("a") && tier.has("c")).toBe(true);
    expect(tier.bytes).toBe(8);
  });

  it("sur le disque : écriture atomique, relu après un « redémarrage », corrompu effacé, évincé sous le plafond", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-audio-cache-"));
    let now = 1_000_000;
    const tier = new DiskTier(dir, () => 3 * 60, () => now);
    const rel = (n: number) => join("4-0123456789ab", "3-x-1a2b3c4d", `${n}.seg`);
    await tier.put(rel(0), new Uint8Array(20).fill(1));
    now += 10;
    await tier.put(rel(1), new Uint8Array(20).fill(2));
    expect(readdirSync(join(dir, "4-0123456789ab", "3-x-1a2b3c4d")).sort()).toEqual(["0.seg", "1.seg"]); // aucun temporaire
    // Un processus neuf relit ce qui est là.
    const fresh = new DiskTier(dir, () => 3 * 60, () => now);
    await fresh.scan();
    expect(fresh.stats.files).toBe(2);
    expect([...(await fresh.get(rel(1)))!]).toEqual(new Array(20).fill(2));
    writeFileSync(join(dir, rel(0)), readFileSync(join(dir, rel(0))).subarray(0, 30));
    expect(await fresh.get(rel(0))).toBeNull();
    expect(fresh.stats.corrupt).toBe(1);
    // Plafond de 180 octets : trois enveloppes de 60 ; la quatrième évince la moins récemment lue.
    now += 10;
    await fresh.put(rel(2), new Uint8Array(20));
    now += 10;
    await fresh.put(rel(3), new Uint8Array(20));
    now += 10;
    await fresh.put(rel(4), new Uint8Array(20));
    await fresh.sweep();
    expect(fresh.stats.bytes).toBeLessThanOrEqual(180);
    expect(fresh.has(rel(1))).toBe(false);
    expect(fresh.has(rel(4))).toBe(true);
  });
});

describe("la file des conversions", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("bornée ; la demande passe devant l'avance ; une avance cède sa place à une demande", async () => {
    const queue = new AudioQueue(() => 2);
    const order: string[] = [];
    const gates = Array.from({ length: 4 }, deferred);
    const job = (name: string, gate: { promise: Promise<void> }) => async (signal: AbortSignal) => {
      order.push(name);
      await Promise.race([gate.promise, new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("tuée"))))]);
    };
    const leadA = queue.push("lead", "s1", job("avance-a", gates[0]));
    const leadB = queue.push("lead", "s1", job("avance-b", gates[1]));
    expect(queue.stats.running).toBe(2);
    const demand = queue.push("demand", "s2", job("demande", gates[2]));
    // La demande a tué l'avance la plus récente et pris sa place.
    await expect(leadB).rejects.toThrow("tuée");
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["avance-a", "avance-b", "demande"]);
    expect(queue.stats.preempted).toBe(1);
    const leadC = queue.push("lead", "s3", job("avance-c", gates[3]));
    // Une seconde demande, toutes les places prises : l'avance qui restait cède à son tour.
    const demand2 = queue.push("demand", "s2", job("demande-2", gates[3]));
    await expect(leadA).rejects.toThrow("tuée");
    await new Promise((r) => setImmediate(r));
    // La place libérée va à la demande, pas à l'avance arrivée avant elle.
    expect(order.slice(3)).toEqual(["demande-2"]);
    expect(queue.stats).toMatchObject({ running: 2, leadQueued: 1, preempted: 2 });
    gates[2].resolve();
    await demand;
    await new Promise((r) => setImmediate(r));
    expect(order.slice(4)).toEqual(["avance-c"]);
    gates[3].resolve();
    await Promise.all([demand2, leadC]);
    // Une avance encore en attente d'une lecture arrêtée est retirée.
    const stuck = deferred();
    const busy = [queue.push("demand", "x", job("d1", stuck)), queue.push("demand", "x", job("d2", stuck))];
    const dropped = queue.push("lead", "s9", job("jamais", stuck));
    queue.dropLead("s9");
    await expect(dropped).rejects.toThrow("Avance abandonnée");
    stuck.resolve();
    await Promise.all(busy);
    expect(queue.waitP90()).toBeGreaterThanOrEqual(0);
  });
});

describe("les noms des rendus convertis", () => {
  it("l'identité de la conversion est dans le nom ; un nom simple reste celui d'une piste copiée", () => {
    expect(renditionTag({ kind: "audio", track: 3, conv: "1a2b3c4d" })).toBe("a3x1a2b3c4d");
    expect(parseLumenPath("a3x1a2b3c4d/12.m4s")).toEqual({ kind: "segment", rendition: { kind: "audio", track: 3, conv: "1a2b3c4d" }, n: 12 });
    expect(parseLumenPath("init-a3x1a2b3c4d.mp4")).toEqual({ kind: "init", rendition: { kind: "audio", track: 3, conv: "1a2b3c4d" } });
    expect(parseLumenPath("a3.m3u8")).toEqual({ kind: "playlist", rendition: { kind: "audio", track: 3 } });
    expect(parseLumenPath("a3xZZ.m3u8")).toBeNull();
  });
});

describe("le pool de ffmpeg pré-lancés (le levier de lancement, §163)", () => {
  it("la fenêtre posée par Node : ce que font `atrim`, `adelay`, `apad` dans la voie à un processus", async () => {
    const { windowPcm, decoderStageArgs, encoderStageArgs } = await import("@/lib/lumenServer/audio/convert");
    const pcm = Float32Array.from({ length: 20 }, (_, i) => i + 1); // 10 trames stéréo
    // Le décodé commence 3 trames avant la fenêtre : coupé devant ; la fenêtre dépasse sa fin : des zéros derrière.
    expect([...windowPcm(pcm, 100, { start: 103, end: 112 }, 2)]).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 0, 0, 0, 0]);
    // Le son commence dans la fenêtre : des zéros devant.
    expect([...windowPcm(pcm.subarray(0, 4), 102, { start: 100, end: 105 }, 2)]).toEqual([0, 0, 0, 0, 1, 2, 3, 4, 0, 0]);
    expect([...windowPcm(null, 0, { start: 0, end: 2 }, 2)]).toEqual([0, 0, 0, 0]);
    // Des arguments génériques : rien qui dépende de la fenêtre, aucun chemin.
    const dec = decoderStageArgs({ format: "dts" }, 6, TARGET_51);
    expect(dec.join(" ")).not.toMatch(/atrim|adelay|apad|\//);
    expect(dec.slice(-3)).toEqual(["-f", "f32le", "pipe:1"]);
    expect(encoderStageArgs(TARGET_20)).toContain("stereo");
  });

  it("un processus au repos par clé, servi une fois puis remplacé ; tué au repos et à la fermeture", async () => {
    const { FfmpegPool } = await import("@/lib/lumenServer/audio/ffmpegPool");
    const pool = new FfmpegPool(() => process.execPath);
    const args = ["-e", "process.stdin.pipe(process.stdout)"];
    const first = pool.take(args);
    expect(pool.stats).toMatchObject({ cold: 1, warm: 0 });
    expect([...(await first.feed(Uint8Array.of(9), { timeoutMs: 10_000 })).stdout]).toEqual([9]);
    await new Promise((r) => setTimeout(r, 50));
    expect(pool.size()).toBe(1); // le remplaçant attend
    const second = pool.take(args);
    expect(pool.stats.warm).toBe(1);
    expect([...(await second.feed(Uint8Array.of(7), { timeoutMs: 10_000 })).stdout]).toEqual([7]);
    await new Promise((r) => setTimeout(r, 50));
    pool.sweep(Date.now() + 120_000);
    expect(pool.size()).toBe(0);
    expect(pool.stats.expired).toBe(1);
    pool.take(args);
    await new Promise((r) => setTimeout(r, 50));
    pool.close();
    expect(pool.size()).toBe(0);
  });
});

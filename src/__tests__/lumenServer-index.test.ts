import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { openMediaFile, createSampleReader } from "@/lib/webcodecs/mediaFile";
import { isRandomAccessPoint, isRaslPicture, nalLengthSize, strayUnits } from "@/lib/webcodecs/codecConfig";
import { readBlockSamples, sketchPicture, walkBlocks } from "@/lib/lumenServer/mkvBlocks";
import { lumenEligibility } from "@/lib/lumenServer/eligibility";
import { MemoryByteSource } from "@/lib/webcodecs/byteSource";
import { FIXTURES, fixtureIndex } from "./lumenServer-helpers";

// Le lecteur d'index léger : il doit dire de chaque image ce que les prédicats du lecteur disent de
// l'image entière, en lisant cent fois moins ; et rendre les mêmes échantillons que `SampleReader`
// pour la piste qu'on lui demande.

const MATROSKA = ["hevc-cra.mkv", "hevc-cra-sans-rasl.mkv", "hevc-idr.mkv", "h264-aac.mkv", "h264-opengop.mkv"];

describe.each(MATROSKA)("%s, lu par en-têtes", (name) => {
  it("rend, pour chaque piste, exactement les échantillons de SampleReader", async () => {
    const source = await FileByteSource.open(join(FIXTURES, name));
    try {
      const file = await openMediaFile(source);
      const reader = createSampleReader(source, file, file.firstClusterOffset!);
      const reference = new Map<number, string[]>();
      for (let s = await reader.next(); s; s = await reader.next()) {
        reference.set(s.trackNumber, [...(reference.get(s.trackNumber) ?? []), `${s.timestampUs}:${s.isKey}:${Buffer.from(s.data).toString("hex")}`]);
      }
      const walked = new Map<number, string[]>();
      await walkBlocks(source, file, file.firstClusterOffset!, async (head) => {
        for (const s of await readBlockSamples(source, file, head)) {
          expect(s.timestampUs).toBe(head.timeUs);
          walked.set(s.trackNumber, [...(walked.get(s.trackNumber) ?? []), `${s.timestampUs}:${s.isKey}:${Buffer.from(s.data).toString("hex")}`]);
        }
      });
      expect(walked).toEqual(reference);
    } finally {
      source.close();
    }
  });

  it("la tête d'une image répond comme l'image entière à isRandomAccessPoint, isRaslPicture et strayUnits", async () => {
    const source = await FileByteSource.open(join(FIXTURES, name));
    try {
      const file = await openMediaFile(source);
      const video = file.tracks.find((t) => t.type === "video")!;
      const ls = nalLengthSize(video.codecId, video.codecPrivate);
      let pictures = 0;
      await walkBlocks(source, file, file.firstClusterOffset!, async (head) => {
        if (head.track !== video.number || head.frameOffset === null) return;
        const [whole] = await readBlockSamples(source, file, head);
        const { sketch, slice } = await sketchPicture(source, head.frameOffset, head.frameSize, ls, video.codecId);
        expect(sketch.length).toBeLessThan(Math.max(200, whole.data.length));
        expect(isRandomAccessPoint(sketch, video.codecId, ls)).toBe(isRandomAccessPoint(whole.data, video.codecId, ls));
        expect(isRaslPicture(sketch, video.codecId, ls)).toBe(isRaslPicture(whole.data, video.codecId, ls));
        expect(slice).toBe(strayUnits(whole.data, video.codecId, ls) === null);
        pictures += 1;
      });
      expect(pictures).toBe(144);
    } finally {
      source.close();
    }
  });
});

describe("sketchPicture sur des formes que les fichiers synthétiques ne font pas", () => {
  const unit = (header: number[], length: number) => [(length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff, ...header, ...new Array(length - header.length).fill(0x55)];

  it("un bloc égaré (VPS, SPS, PPS, RPU, aucune tranche) n'est pas une image", async () => {
    const bytes = new Uint8Array([...unit([0x40, 0x01], 20), ...unit([0x42, 0x01], 30), ...unit([0x44, 0x01], 10), ...unit([0x7c, 0x01], 300)]);
    const { slice, sketch } = await sketchPicture(new MemoryByteSource(bytes), 0, bytes.length, 4, "V_MPEGH/ISO/HEVC");
    expect(slice).toBe(false);
    expect(strayUnits(sketch, "V_MPEGH/ISO/HEVC", 4)).not.toBeNull();
    expect(strayUnits(bytes, "V_MPEGH/ISO/HEVC", 4)).not.toBeNull();
  });

  it("un gros SEI devant la tranche est franchi par sa longueur, sans être lu", async () => {
    // SEI préfixe (39) de 100 000 octets, puis une CRA (21).
    const bytes = new Uint8Array([...unit([0x4e, 0x01], 100_000), ...unit([0x2a, 0x01], 5000)]);
    const source = new MemoryByteSource(bytes);
    const { slice, sketch } = await sketchPicture(source, 0, bytes.length, 4, "V_MPEGH/ISO/HEVC");
    expect(slice).toBe(true);
    expect(sketch.length).toBeLessThan(64);
    expect(isRandomAccessPoint(sketch, "V_MPEGH/ISO/HEVC", 4)).toBe(true);
  });

  it("une longueur fausse arrête la marche au même endroit que sur l'image entière", async () => {
    const bytes = new Uint8Array([0, 0, 0xff, 0xff, 0x26, 0x01, 1, 2, 3]);
    const { sketch } = await sketchPicture(new MemoryByteSource(bytes), 0, bytes.length, 4, "V_MPEGH/ISO/HEVC");
    expect(isRandomAccessPoint(sketch, "V_MPEGH/ISO/HEVC", 4)).toBe(isRandomAccessPoint(bytes, "V_MPEGH/ISO/HEVC", 4));
  });
});

describe("l'index et l'éligibilité", () => {
  it("`idr` lit l'index en quelques lectures, sans lire les images", async () => {
    const { index, source } = await fixtureIndex("hevc-cra.mkv", undefined, "idr");
    source.close();
    // À 4 s de cible, seuls les points dont la découpe a besoin sont lus : 0 s (IDR, admise), 4 s
    // (CRA à RASL, refusée), puis 5 s (même chose).
    expect(index.keys).toMatchObject({ cues: 6, verified: 3, rejected: 0, idr: 1, cra: 2, craRasl: 2, cuts: 1, trusted: 0 });
    expect(index.cost.reads).toBeLessThan(20);
  });

  it("la règle (`cra`, §158) se construit depuis les Cues : seule la première clé est lue", async () => {
    const { index, source } = await fixtureIndex("hevc-cra.mkv");
    source.close();
    const idr = await fixtureIndex("hevc-cra.mkv", undefined, "idr");
    idr.source.close();
    expect(index.cut).toBe("cra");
    // 0 s (l'IDR, lue), puis 4 s (une CRA à RASL, prise sans être lue) : ses RASL restent dans son segment.
    expect(index.keys).toMatchObject({ cues: 6, verified: 1, rejected: 0, idr: 1, cra: 0, craRasl: 0, cuts: 2, trusted: 1 });
    expect(index.segments.map((s) => s.keyUs)).toEqual([0, 4_000_000]);
    expect(index.cost.reads).toBeLessThan(idr.index.cost.reads);
  });

  it("refuse un Matroska sans index, un son en retard, un son plus court que l'image, un codec non copiable", async () => {
    const cases: [string, string, "audio" | "file"][] = [
      ["h264-nocues.mkv", "pas-d-index", "file"],
      ["h264-late.mkv", "son-en-retard", "audio"],
      ["h264-short.mkv", "son-plus-court", "audio"],
    ];
    for (const [name, reason] of cases) {
      const { index, source } = await fixtureIndex(name, 1_000_000);
      source.close();
      const verdict = lumenEligibility(index, index.audio[0]?.number ?? 1);
      expect([name, verdict.ok ? "ok" : verdict.reason]).toEqual([name, reason]);
    }
    const { index, source } = await fixtureIndex("hevc-cra.mkv");
    source.close();
    const [eac3, ac3, opus] = index.audio;
    expect([eac3.codecId, ac3.codecId, opus.codecId]).toEqual(["A_EAC3", "A_AC3", "A_OPUS"]);
    expect(lumenEligibility(index, eac3.number)).toEqual({ ok: true });
    expect(lumenEligibility(index, ac3.number)).toEqual({ ok: true });
    expect(lumenEligibility(index, opus.number)).toEqual({ ok: false, reason: "son-codec", detail: "A_OPUS" });
    expect(lumenEligibility(index, 42)).toMatchObject({ ok: false, reason: "piste-inconnue" });
    expect(lumenEligibility(index, null)).toEqual({ ok: true });
  });

  it("un fichier illisible n'est pas une exception : un refus", async () => {
    const { buildLumenIndex } = await import("@/lib/lumenServer/lumenIndex");
    const garbage = new MemoryByteSource(new Uint8Array(4096).fill(7));
    const index = await buildLumenIndex(garbage, { path: "/x", size: 4096, mtimeMs: 0, ino: 0 });
    expect(lumenEligibility(index, null)).toMatchObject({ ok: false, reason: "lecture-impossible" });
  });

  it("décrit chaque piste pour la liste depuis ce que l'init porte", async () => {
    const { index, source } = await fixtureIndex("hevc-cra.mkv");
    source.close();
    expect(index.video!.signal).toMatchObject({ entry: "hvc1", videoRange: "SDR" });
    expect(index.audio.map((a) => a.signal?.codecs ?? null)).toEqual(["ec-3", "ac-3", null]);
    expect(index.audio[1].signal!.channels).toBe("6");
    expect(Object.keys(index.inits.audio).map(Number)).toEqual([index.audio[0].number, index.audio[1].number]);
    // ftyp puis moov.
    expect(Buffer.from(index.inits.video!.subarray(4, 8)).toString()).toBe("ftyp");
  });

  it("MP4 : son propre index (stss, stts, ctts), sans Cues", async () => {
    const { index, source } = await fixtureIndex("h264.mp4", 1_000_000, "idr");
    source.close();
    expect(index.container).toBe("mp4");
    expect(index.keys).toMatchObject({ verified: 6, idr: 6, cuts: 6 });
    expect(index.segments.map((s) => s.at)).toEqual([0, 24, 48, 72, 96, 120]);
    // Sous la règle, le même index (`stss`) sans lire que la première clé : les mêmes segments.
    const trusted = await fixtureIndex("h264.mp4", 1_000_000);
    trusted.source.close();
    expect(trusted.index.keys).toMatchObject({ verified: 1, idr: 1, cuts: 6, trusted: 5 });
    expect(trusted.index.segments).toEqual(index.segments);
    expect(lumenEligibility(index, index.audio[0].number)).toEqual({ ok: true });
  });
});

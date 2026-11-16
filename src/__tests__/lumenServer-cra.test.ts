import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { openMediaFile, createSampleReader } from "@/lib/webcodecs/mediaFile";
import { isRaslPicture } from "@/lib/webcodecs/codecConfig";
import { createHash } from "node:crypto";
import { buildSegment, leadingOf, segmentSpec } from "@/lib/lumenServer/segment";
import { mediaSegment } from "@/lib/webcodecs/mp4Muxer";
import { masterPlaylist, mediaPlaylist } from "@/lib/lumenServer/playlists";
import { lumenIndexStore, storeKey, STORE_VERSION } from "@/lib/lumenServer/indexStore";
import { clearLumenIndexCache, lumenIndexCacheStats } from "@/lib/lumenServer/indexCache";
import { LumenEngine } from "@/lib/lumenServer/engine";
import { isCut, type VerifiedKey } from "@/lib/lumenServer/lumenIndex";
import {
  cutModeOfTag,
  identityKey,
  LUMEN_CUT_MODES,
  LUMEN_FORMAT_VERSION,
  lumenFormatTag,
  parseCutMode,
  type LumenCutMode,
  type LumenIndex,
  type LumenRendition,
} from "@/lib/lumenServer/format";
import type { MediaSample } from "@/lib/webcodecs/matroska";
import { endDecode, FIXTURES, fixtureIndex, parseFragments, type ParsedFragment } from "./lumenServer-helpers";

// La découpe expérimentale `cra` (étape 3b, DECISIONS.md §157) : un segment peut commencer sur une CRA
// suivie de RASL, et ses RASL y restent. Ce que ces tests tiennent :
// 1. **par défaut, rien ne change** — un index construit sans rien demander est celui de la règle `idr`,
//    son adresse, sa clé de cache et ses octets sont ceux d'avant ;
// 2. **sous `cra`, le contrat d'un HLS sans état tient encore** — chaque image une fois, RASL comprises,
//    contiguës d'un segment à l'autre, le son sur les mêmes frontières ;
// 3. **les deux découpes ne se mélangent jamais** — version de format, cache mémoire, cache disque ;
// 4. `cra-leading` nomme chaque image non clé (`is_leading` : RASL 1, RADL 3, autre 2), et le muxer sans
//    l'option écrit exactement les octets d'avant.

const LABELS = { locale: "fr", canaux: (n: number) => `${n} canaux`, piste: (n: number) => `Piste ${n}` };
/** Les drapeaux qu'écrit le muxer : synchronisation, dépendance, et sous `cra-leading` `is_leading` (bits 27–26). */
const SYNC = 0x02000000;
const DEPENDENT = 0x01010000;
const RASL_FLAGS = 0x05010000;
const NOT_LEADING_FLAGS = 0x09010000;
const RADL_FLAGS = 0x0d010000;
/** `mediaSegment` des trois échantillons du test du muxer, tel que le code d'avant l'étape 3b l'écrit. */
const PLAIN_SEGMENT_SHA256 = "0436a66d38516a761250b8e16357a2556059920ca892ebaea9108910482961c2";

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

async function allSegments(index: LumenIndex, rendition: LumenRendition): Promise<{ bytes: Uint8Array; fragments: ParsedFragment[] }[]> {
  const out = [];
  for (let n = 0; n < index.segments.length; n++) {
    const spec = segmentSpec(index, rendition, n);
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

async function indexOf(name: string, cut?: LumenCutMode, targetUs = 1_000_000): Promise<LumenIndex> {
  const { index, source } = await fixtureIndex(name, targetUs, cut);
  source.close();
  return index;
}

/** L'index sans ce qui varie d'une construction à l'autre (le temps et les lectures). */
function stable(index: LumenIndex) {
  const { cost: _cost, ...rest } = index;
  void _cost;
  return rest;
}

describe("la version de format d'une découpe", () => {
  it("`idr` garde exactement l'ancienne ; les essais ont chacun la leur, et elles se relisent", () => {
    expect(lumenFormatTag("idr")).toBe(String(LUMEN_FORMAT_VERSION));
    const tags = LUMEN_CUT_MODES.map(lumenFormatTag);
    expect(new Set(tags).size).toBe(LUMEN_CUT_MODES.length);
    for (const cut of LUMEN_CUT_MODES) expect(cutModeOfTag(lumenFormatTag(cut))).toBe(cut);
    expect(cutModeOfTag("0")).toBeNull();
    expect(cutModeOfTag(`${LUMEN_FORMAT_VERSION + 1}`)).toBeNull();
  });

  it("`?cut=` : un mode connu, la règle si absent, null sinon", () => {
    expect(parseCutMode(null)).toBeUndefined();
    expect(parseCutMode("")).toBeUndefined();
    expect(parseCutMode("cra")).toBe("cra");
    expect(parseCutMode("cra-leading")).toBe("cra-leading");
    expect(parseCutMode("CRA")).toBeNull();
    expect(parseCutMode("tout")).toBeNull();
  });

  it("`isCut` : seule la CRA à RASL change d'avis ; l'I H.264 à images de tête reste refusée partout", () => {
    const key = (k: Partial<VerifiedKey>): VerifiedKey => ({ timeUs: 0, at: 0, kind: "cra", rasl: false, leading: false, ...k });
    for (const cut of LUMEN_CUT_MODES) {
      expect(isCut(key({ kind: "idr" }), cut)).toBe(true);
      expect(isCut(key({ kind: "cra" }), cut)).toBe(true);
      expect(isCut(key({ kind: "i-recovery", leading: true }), cut)).toBe(false);
      expect(isCut(key({ kind: "autre" }), cut)).toBe(false);
    }
    expect(isCut(key({ rasl: true }))).toBe(false);
    expect(isCut(key({ rasl: true }), "idr")).toBe(false);
    expect(isCut(key({ rasl: true }), "cra")).toBe(true);
    expect(isCut(key({ rasl: true }), "cra-leading")).toBe(true);
  });
});

describe("par défaut, rien ne change", () => {
  it.each(["hevc-cra.mkv", "hevc-idr.mkv", "h264-aac.mkv", "h264.mp4"])("%s : l'index sans découpe demandée est celui de `idr`", async (name) => {
    const plain = await indexOf(name);
    const idr = await indexOf(name, "idr");
    expect(plain.cut).toBe("idr");
    expect(stable(plain)).toEqual(stable(idr));
  });

  it("une CRA à RASL n'ouvre toujours pas de segment sous la règle, et aucun échantillon n'est marqué", async () => {
    const index = await indexOf("hevc-cra.mkv");
    expect(index.keys.craRasl).toBeGreaterThan(0);
    expect(index.segments).toHaveLength(1);
    const [segment] = await allSegments(index, { kind: "video" });
    for (const f of segment.fragments) for (const s of f.samples) expect([SYNC, DEPENDENT]).toContain(s.flags);
    expect(mediaPlaylist(index, { kind: "video" })).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(masterPlaylist(index, { audioTrack: null, labels: LABELS })).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
  });
});

describe.each(["cra", "cra-leading"] as const)("la découpe `%s` sur un HEVC à GOP ouvert", (cut) => {
  it("coupe sur les CRA à RASL, et chaque segment en ouvre une, RASL gardées derrière elle", async () => {
    const index = await indexOf("hevc-cra.mkv", cut);
    expect(index.cut).toBe(cut);
    expect(index.refusal).toBeNull();
    expect(index.segments.length).toBeGreaterThan(1);
    expect(index.keys.craRasl).toBeGreaterThan(0);
    const segments = await allSegments(index, { kind: "video" });
    for (let n = 1; n < segments.length; n++) {
      const first = segments[n].fragments[0];
      expect(first.samples[0].flags).toBe(SYNC);
      // La CRA, puis ses RASL (affichées avant elle) : gardées, pas écartées comme le fait le remuxeur MSE.
      expect(isRaslPicture(first.data[1], "V_MPEGH/ISO/HEVC", index.video!.lengthSize)).toBe(true);
    }
  });

  it("chaque image une fois, RASL comprises, contiguës d'un segment à l'autre ; le son sur les mêmes frontières", async () => {
    const index = await indexOf("hevc-cra.mkv", cut);
    const video = await allSegments(index, { kind: "video" });
    for (let n = 1; n < video.length; n++) expect([n, video[n].fragments[0].baseDecode]).toEqual([n, endDecode(video[n - 1].fragments)]);
    const produced = video.flatMap((s) => s.fragments.flatMap((f) => f.samples.map((x, i) => ({ pts: x.decode + x.cto - index.delayUs, data: f.data[i], decode: x.decode }))));
    for (let i = 1; i < produced.length; i++) expect(produced[i].decode).toBeGreaterThan(produced[i - 1].decode);
    const reference = await referenceSamples("hevc-cra.mkv", index.video!.number);
    expect(produced.map((p) => p.pts)).toEqual(reference.map((r) => r.timestampUs));
    produced.forEach((p, i) => expect(Buffer.compare(Buffer.from(p.data), Buffer.from(reference[i].data))).toBe(0));

    for (const track of index.audio.filter((a) => !a.refusal)) {
      const audio = await allSegments(index, { kind: "audio", track: track.number });
      for (let n = 1; n < audio.length; n++) {
        expect([track.number, n, audio[n].fragments[0].baseDecode]).toEqual([track.number, n, endDecode(audio[n - 1].fragments)]);
        expect(Math.abs(audio[n].fragments[0].baseDecode - index.delayUs - index.segments[n].startUs)).toBeLessThan(50_000);
      }
      const frames = audio.flatMap((s) => s.fragments.flatMap((f) => f.data));
      const ref = (await referenceSamples("hevc-cra.mkv", track.number)).filter((r) => r.timestampUs + index.delayUs >= 0);
      expect(frames.length).toBe(ref.length);
    }
  });

  it("les listes ne disent plus EXT-X-INDEPENDENT-SEGMENTS : ce serait faux", async () => {
    const index = await indexOf("hevc-cra.mkv", cut);
    expect(mediaPlaylist(index, { kind: "video" })).not.toContain("INDEPENDENT-SEGMENTS");
    expect(masterPlaylist(index, { audioTrack: null, labels: LABELS })).not.toContain("INDEPENDENT-SEGMENTS");
  });
});

describe("le marquage des images de tête", () => {
  it("`cra-leading` : RASL `is_leading` = 1, RADL 3, toute autre non-clé 2, clés inchangées ; `cra` n'écrit que les drapeaux d'avant", async () => {
    for (const cut of ["cra", "cra-leading"] as const) {
      const index = await indexOf("hevc-cra.mkv", cut);
      const segments = await allSegments(index, { kind: "video" });
      const seen = { rasl: 0, other: 0 };
      for (const s of segments) {
        for (const f of s.fragments) {
          f.samples.forEach((sample, i) => {
            const lead = leadingOf(f.data[i], "V_MPEGH/ISO/HEVC", index.video!.lengthSize);
            const isKey = sample.flags === SYNC;
            if (lead === 1) seen.rasl += 1;
            else if (!isKey) seen.other += 1;
            if (cut === "cra") expect([SYNC, DEPENDENT]).toContain(sample.flags);
            else if (isKey) expect(isRaslPicture(f.data[i], "V_MPEGH/ISO/HEVC", index.video!.lengthSize)).toBe(false);
            else expect(sample.flags).toBe(lead === 1 ? RASL_FLAGS : lead === 3 ? RADL_FLAGS : NOT_LEADING_FLAGS);
          });
        }
      }
      expect(seen.rasl).toBeGreaterThan(0);
      expect(seen.other).toBeGreaterThan(0);
    }
  });

  it("`leadingOf` lit le type de la tranche : RASL, RADL, le reste", () => {
    const picture = (type: number) => new Uint8Array([0, 0, 0, 3, type << 1, 1, 0xaa]);
    const withPrefix = (type: number) => new Uint8Array([0, 0, 0, 3, 39 << 1, 1, 0x05, ...picture(type)]); // SEI préfixe d'abord
    expect(leadingOf(picture(8), "V_MPEGH/ISO/HEVC", 4)).toBe(1);
    expect(leadingOf(picture(9), "V_MPEGH/ISO/HEVC", 4)).toBe(1);
    expect(leadingOf(picture(6), "V_MPEGH/ISO/HEVC", 4)).toBe(3);
    expect(leadingOf(picture(7), "V_MPEGH/ISO/HEVC", 4)).toBe(3);
    expect(leadingOf(picture(1), "V_MPEGH/ISO/HEVC", 4)).toBe(2);
    expect(leadingOf(withPrefix(8), "V_MPEGH/ISO/HEVC", 4)).toBe(1);
    expect(leadingOf(picture(8), "V_MPEG4/ISO/AVC", 4)).toBe(2);
  });

  it("le muxer sans `isLeading` écrit les octets d'avant ; avec, seulement les deux bits de `is_leading`", () => {
    const info = { id: 1, kind: "video" as const, timescale: 1_000_000, sampleEntry: new Uint8Array(0), width: 0, height: 0, language: "und" };
    const base = [
      { data: new Uint8Array([1, 2, 3]), decodeTime: 0, duration: 40_000, compositionOffset: 80_000, isKeyframe: true },
      { data: new Uint8Array([4, 5]), decodeTime: 40_000, duration: 40_000, compositionOffset: -40_000, isKeyframe: false },
      { data: new Uint8Array([6]), decodeTime: 80_000, duration: 40_000, compositionOffset: 0, isKeyframe: false },
    ];
    // L'empreinte des octets que le chemin MediaSource écrit depuis toujours pour ces échantillons : elle ne bouge pas.
    const plain = mediaSegment(info, 7, base);
    expect(createHash("sha256").update(plain).digest("hex")).toBe(PLAIN_SEGMENT_SHA256);
    const flagsOf = (bytes: Uint8Array) => parseFragments(bytes)[0].samples.map((x) => x.flags);
    expect(flagsOf(plain)).toEqual([SYNC, DEPENDENT, DEPENDENT]);
    const marked = mediaSegment(info, 7, [base[0], { ...base[1], isLeading: 1 }, { ...base[2], isLeading: 3 }]);
    expect(flagsOf(marked)).toEqual([SYNC, RASL_FLAGS, RADL_FLAGS]);
    expect(flagsOf(mediaSegment(info, 7, [base[0], { ...base[1], isLeading: 2 }, base[2]]))).toEqual([SYNC, NOT_LEADING_FLAGS, DEPENDENT]);
    expect(marked.length).toBe(plain.length);
  });
});

describe("les deux découpes ne se mélangent jamais", () => {
  it("cache disque : la clé de `idr` est celle d'avant ; un index `cra` n'est jamais relu pour `idr`, ni l'inverse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laterna-lumen-cra-store-"));
    const store = lumenIndexStore(dir);
    const idr = await indexOf("hevc-cra.mkv", undefined, 4_000_000);
    const cra = await indexOf("hevc-cra.mkv", "cra", 4_000_000);
    expect(storeKey(idr.identity)).toBe(`${STORE_VERSION}|${LUMEN_FORMAT_VERSION}|-|${identityKey(idr.identity)}`);
    expect(storeKey(idr.identity, undefined, "cra")).not.toBe(storeKey(idr.identity));

    await store.put(cra);
    expect(await store.get(cra.identity)).toBeNull();
    expect((await store.get(cra.identity, undefined, "cra"))?.cut).toBe("cra");
    await store.put(idr);
    expect((await store.get(idr.identity))?.segments).toEqual(idr.segments);
    expect((await store.get(idr.identity, undefined, "cra"))?.segments).toEqual(cra.segments);
  });

  it("cache disque : un index écrit avant l'étape 3b (sans `cut`) se relit comme `idr`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laterna-lumen-cra-legacy-"));
    const store = lumenIndexStore(dir);
    const idr = await indexOf("hevc-cra.mkv", undefined, 4_000_000);
    const { cut: _cut, ...legacy } = idr;
    void _cut;
    await store.put(legacy as LumenIndex);
    const read = await store.get(idr.identity);
    expect(read?.cut).toBe("idr");
    expect(mediaPlaylist(read!, { kind: "video" })).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
  });

  it("cache mémoire et moteur : un index par découpe, chacun gardé, aucun ne remplace l'autre", async () => {
    clearLumenIndexCache();
    const engine = new LumenEngine();
    const path = join(FIXTURES, "hevc-cra.mkv");
    const [idr, cra] = await Promise.all([engine.index(path), engine.index(path, undefined, "cra")]);
    expect(idr.cut).toBe("idr");
    expect(cra.cut).toBe("cra");
    expect(cra.segments.length).toBeGreaterThan(idr.segments.length);
    expect(lumenIndexCacheStats().entries).toBe(2);
    expect(await engine.index(path)).toBe(idr);
    expect(await engine.index(path, undefined, "cra")).toBe(cra);
    expect(lumenIndexCacheStats().hits).toBe(2);
    await engine.close();
    clearLumenIndexCache();
  });
});

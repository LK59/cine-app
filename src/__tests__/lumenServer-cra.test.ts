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
  cuttingOfTag,
  identityKey,
  LUMEN_CUT_MODES,
  LUMEN_FORMAT_VERSION,
  LUMEN_TARGET_SEGMENT_US,
  LUMEN_TRIAL_TARGETS_S,
  lumenFormatTag,
  parseCutMode,
  parseTargetSeconds,
  type LumenCutMode,
  type LumenIndex,
  type LumenRendition,
} from "@/lib/lumenServer/format";
import type { MediaSample } from "@/lib/webcodecs/matroska";
import { endDecode, FIXTURES, fixtureIndex, parseFragments, type ParsedFragment } from "./lumenServer-helpers";

// La découpe `cra` (étape 3b, DECISIONS.md §157 ; la règle depuis le format 2, §158) : un segment peut
// commencer sur une CRA suivie de RASL, et ses RASL y restent. Ce que ces tests tiennent :
// 1. **par défaut, c'est `cra`** — un index construit sans rien demander est celui de `cra`, depuis les
//    Cues ; `idr` reste un essai, avec sa vérification point par point ;
// 2. **sous `cra`, le contrat d'un HLS sans état tient encore** — chaque image une fois, RASL comprises,
//    contiguës d'un segment à l'autre, le son sur les mêmes frontières ;
// 3. **deux découpes, ou deux cibles, ne se mélangent jamais** — version de format, cache mémoire, cache disque ;
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
  it("la règle porte la version seule ; chaque essai (découpe, cible) a la sienne, et elles se relisent", () => {
    expect(lumenFormatTag()).toBe(String(LUMEN_FORMAT_VERSION));
    expect(lumenFormatTag("cra", LUMEN_TARGET_SEGMENT_US)).toBe(String(LUMEN_FORMAT_VERSION));
    expect(lumenFormatTag("idr")).toBe(`${LUMEN_FORMAT_VERSION}i1`);
    expect(lumenFormatTag("cra-leading")).toBe(`${LUMEN_FORMAT_VERSION}l1`);
    expect(lumenFormatTag("cra", 2_000_000)).toBe(`${LUMEN_FORMAT_VERSION}t2`);
    expect(lumenFormatTag("idr", 2_000_000)).toBe(`${LUMEN_FORMAT_VERSION}i1t2`);
    const all = LUMEN_CUT_MODES.flatMap((cut) => [4, ...LUMEN_TRIAL_TARGETS_S].map((s) => ({ cut, targetUs: s * 1e6 })));
    const tags = all.map((c) => lumenFormatTag(c.cut, c.targetUs));
    expect(new Set(tags).size).toBe(all.length);
    for (const c of all) expect(cuttingOfTag(lumenFormatTag(c.cut, c.targetUs))).toEqual(c);
    // Le format 1 (la règle `idr` d'avant, ses essais `1c1`, `1l1`) ne désigne plus rien.
    for (const old of ["0", "1", "1c1", "1l1", `${LUMEN_FORMAT_VERSION + 1}`, `${LUMEN_FORMAT_VERSION}t5`]) expect(cuttingOfTag(old)).toBeNull();
  });

  it("`?cut=` : un mode connu, la règle si absent, null sinon", () => {
    expect(parseCutMode(null)).toBeUndefined();
    expect(parseCutMode("")).toBeUndefined();
    expect(parseCutMode("cra")).toBe("cra");
    expect(parseCutMode("idr")).toBe("idr");
    expect(parseCutMode("cra-leading")).toBe("cra-leading");
    expect(parseCutMode("CRA")).toBeNull();
    expect(parseCutMode("tout")).toBeNull();
  });

  it("`?target=` : une cible d'essai, 4 s si absente, null sinon", () => {
    expect(parseTargetSeconds(null)).toBeUndefined();
    expect(parseTargetSeconds("")).toBeUndefined();
    expect(parseTargetSeconds("4")).toBe(LUMEN_TARGET_SEGMENT_US);
    expect(parseTargetSeconds("2")).toBe(2_000_000);
    expect(parseTargetSeconds(2)).toBe(2_000_000);
    expect(parseTargetSeconds("6")).toBe(6_000_000);
    for (const bad of ["5", "02", "2.5", "-2", "deux", "40"]) expect(parseTargetSeconds(bad)).toBeNull();
  });

  it("`isCut` : seule la CRA à RASL change d'avis ; l'I H.264 à images de tête reste refusée partout", () => {
    const key = (k: Partial<VerifiedKey>): VerifiedKey => ({ timeUs: 0, at: 0, kind: "cra", rasl: false, leading: false, ...k });
    for (const cut of LUMEN_CUT_MODES) {
      expect(isCut(key({ kind: "idr" }), cut)).toBe(true);
      expect(isCut(key({ kind: "cra" }), cut)).toBe(true);
      expect(isCut(key({ kind: "i-recovery", leading: true }), cut)).toBe(false);
      expect(isCut(key({ kind: "autre" }), cut)).toBe(false);
    }
    expect(isCut(key({ rasl: true }), "idr")).toBe(false);
    expect(isCut(key({ rasl: true }), "cra")).toBe(true);
    expect(isCut(key({ rasl: true }), "cra-leading")).toBe(true);
  });
});

describe("par défaut, la découpe `cra`, depuis les Cues (§158)", () => {
  it.each(["hevc-cra.mkv", "hevc-idr.mkv", "h264-aac.mkv", "h264.mp4"])("%s : l'index sans découpe demandée est celui de `cra`", async (name) => {
    const plain = await indexOf(name);
    const cra = await indexOf(name, "cra");
    expect(plain.cut).toBe("cra");
    expect(stable(plain)).toEqual(stable(cra));
    expect(plain.keys.verified).toBe(1);
  });

  it("sur un fichier à IDR seules, les mêmes frontières que `idr` vérifiée", async () => {
    for (const name of ["hevc-idr.mkv", "h264-aac.mkv"]) {
      const cra = await indexOf(name);
      const idr = await indexOf(name, "idr");
      expect([name, cra.segments]).toEqual([name, idr.segments]);
    }
  });

  it("`idr` garde sa vérification : une CRA à RASL n'y ouvre pas de segment, la liste se dit indépendante", async () => {
    const index = await indexOf("hevc-cra.mkv", "idr");
    expect(index.keys.craRasl).toBeGreaterThan(0);
    expect(index.segments).toHaveLength(1);
    const [segment] = await allSegments(index, { kind: "video" });
    for (const f of segment.fragments) for (const s of f.samples) expect([SYNC, DEPENDENT]).toContain(s.flags);
    expect(mediaPlaylist(index, { kind: "video" })).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(masterPlaylist(index, { audioTrack: null, labels: LABELS })).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
  });

  it("une cible de 2 s : la première clé au moins 2 s après la précédente, et plus de segments qu'à 4 s", async () => {
    const four = await indexOf("hevc-idr.mkv", undefined, 4_000_000);
    const two = await indexOf("hevc-idr.mkv", undefined, 2_000_000);
    expect(two.targetUs).toBe(2_000_000);
    expect(two.segments.length).toBeGreaterThan(four.segments.length);
    for (let n = 1; n < two.segments.length; n++) expect(two.segments[n].keyUs - two.segments[n - 1].keyUs).toBeGreaterThanOrEqual(2_000_000);
  });
});

describe.each(["cra", "cra-leading"] as const)("la découpe `%s` sur un HEVC à GOP ouvert", (cut) => {
  it("coupe sur les CRA à RASL, et chaque segment en ouvre une, RASL gardées derrière elle", async () => {
    const index = await indexOf("hevc-cra.mkv", cut);
    expect(index.cut).toBe(cut);
    expect(index.refusal).toBeNull();
    expect(index.segments.length).toBeGreaterThan(1);
    // L'index des Cues ne lit pas les clés (§158) : ce sont les segments qui montrent les RASL.
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

describe("deux découpes, ou deux cibles, ne se mélangent jamais", () => {
  it("cache disque : la règle a sa clé, chaque essai la sienne ; aucun n'est relu pour un autre", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laterna-lumen-cra-store-"));
    const store = lumenIndexStore(dir);
    const cra = await indexOf("hevc-cra.mkv", undefined, 4_000_000);
    const idr = await indexOf("hevc-cra.mkv", "idr", 4_000_000);
    const two = await indexOf("hevc-cra.mkv", undefined, 2_000_000);
    expect(storeKey(cra.identity)).toBe(`${STORE_VERSION}|${LUMEN_FORMAT_VERSION}|${identityKey(cra.identity)}`);
    // La clé du format 1 (règle `idr`) ne peut plus être produite : ses index ne sont jamais relus.
    expect(storeKey(cra.identity, undefined, "idr")).not.toBe(`${STORE_VERSION}|1|-|${identityKey(cra.identity)}`);
    expect(new Set([storeKey(cra.identity), storeKey(cra.identity, undefined, "idr"), storeKey(cra.identity, 2_000_000)]).size).toBe(3);

    await store.put(idr);
    expect(await store.get(idr.identity)).toBeNull();
    expect((await store.get(idr.identity, undefined, "idr"))?.cut).toBe("idr");
    await store.put(cra);
    await store.put(two);
    expect((await store.get(cra.identity))?.segments).toEqual(cra.segments);
    expect((await store.get(cra.identity, 2_000_000))?.segments).toEqual(two.segments);
    expect((await store.get(idr.identity, undefined, "idr"))?.segments).toEqual(idr.segments);
  });

  it("cache mémoire et moteur : un index par découpe et par cible, chacun gardé, aucun ne remplace l'autre", async () => {
    clearLumenIndexCache();
    const engine = new LumenEngine();
    const path = join(FIXTURES, "hevc-cra.mkv");
    const [cra, idr, two] = await Promise.all([engine.index(path), engine.index(path, undefined, "idr"), engine.index(path, 2_000_000)]);
    expect(cra.cut).toBe("cra");
    expect(idr.cut).toBe("idr");
    expect(two.targetUs).toBe(2_000_000);
    expect(cra.segments.length).toBeGreaterThan(idr.segments.length);
    expect(lumenIndexCacheStats().entries).toBe(3);
    expect(await engine.index(path)).toBe(cra);
    expect(await engine.index(path, undefined, "idr")).toBe(idr);
    expect(await engine.index(path, 2_000_000)).toBe(two);
    expect(lumenIndexCacheStats().hits).toBe(3);
    await engine.close();
    clearLumenIndexCache();
  });
});

// La version allégée de Lumen serveur (`lumenServer/light/`) : ce qui se vérifie sans iGPU. L'encodage réel, l'alignement
// image par image et la couleur sont prouvés par le banc `lumen-light-bench.spec.ts` (VAAPI, vrais fichiers).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { hevcCodecString } from "@/lib/webcodecs/codecConfig";
import { buildSegment, segmentSpec } from "@/lib/lumenServer/segment";
import { masterPlaylist } from "@/lib/lumenServer/playlists";
import { masterTrialOptions, withMasterTrials } from "@/lib/lumenServer/trials";
import { parseLumenPath, renditionTag, segmentName, type LumenIndex } from "@/lib/lumenServer/format";
import { LumenEngine } from "@/lib/lumenServer/engine";
import { annexBUnits, hevcPictures, hvcCFromParameterSets, isIdrPicture, lengthPrefixed, originTimes, readHevcSps } from "@/lib/lumenServer/light/bitstream";
import { lightRungs, rungCodecs, rungSize, RUNG_SHAPES } from "@/lib/lumenServer/light/rungs";
import { encodeArgs, encodedFramesMs, firstEncodedMs } from "@/lib/lumenServer/light/encoder";
import { lightSegment } from "@/lib/lumenServer/light/segment";
import { withLight } from "@/lib/lumenServer/light/view";
import { lightOrder } from "@/lib/lumenServer/serve";
import { lightRungFor, withLightFirst } from "@/components/player/lumen/lumenLink";
import { QualityTally } from "@/components/player/lumen/lumenQuality";
import { fixtureIndex, parseFragments } from "./lumenServer-helpers";

const labels = { locale: "fr", canaux: (n: number) => `${n} canaux`, piste: (n: number) => `Piste ${n}` };
const encoder = { version: "8.1.3", driver: "Intel iHD driver 26.2.1" };

/** Une unité NAL HEVC : son en-tête (type, couche 0, tid 1) puis la charge. */
const nal = (type: number, ...payload: number[]) => Uint8Array.from([type << 1, 1, ...payload]);
const annexB = (units: Uint8Array[]) => Uint8Array.from(units.flatMap((u) => [0, 0, 0, 1, ...u]));

let index: LumenIndex;
let source: Awaited<ReturnType<typeof fixtureIndex>>["source"];
beforeAll(async () => {
  ({ index, source } = await fixtureIndex("hevc-cra.mkv"));
});
afterAll(() => source.close());

/** L'index du fixture, lourd comme un film 4K (le fixture lui-même ne pèse rien : aucun échelon ne le justifierait). */
const heavy = (over: Partial<LumenIndex> = {}): LumenIndex => ({ ...index, bandwidth: { peak: 40_000_000, average: 25_000_000 }, ...over });

describe("les échelons", () => {
  it("deux échelons pour une source lourde, un seul ou aucun sinon ; jamais pour un MP4 ou un codec que le iGPU ne décode pas", () => {
    const rungs = lightRungs(heavy(), encoder);
    expect(rungs.map((r) => r.rung)).toEqual([1, 2]);
    // 8 bits (le fixture est SDR) : 6 et 2,5 Mb/s en moyenne.
    expect(rungs.map((r) => r.averageBps)).toEqual([6_000_000, 2_500_000]);
    expect(rungs.map((r) => r.codecs)).toEqual(["hvc1.1.6.L123.B0", "hvc1.1.6.L93.B0"]);
    expect(rungs.every((r) => /^[0-9a-f]{8}$/.test(r.cid))).toBe(true);
    // Entre 5 et 12 Mb/s : l2 seul (l1 voudrait le double de ses 6 Mb/s).
    expect(lightRungs(heavy({ bandwidth: { peak: 12e6, average: 8e6 } }), encoder).map((r) => r.rung)).toEqual([2]);
    expect(lightRungs(heavy({ bandwidth: { peak: 6e6, average: 4e6 } }), encoder)).toEqual([]);
    expect(lightRungs(heavy({ container: "mp4" }), encoder)).toEqual([]);
    expect(lightRungs(heavy({ video: { ...index.video!, codecId: "V_AV1" } }), encoder)).toEqual([]);
  });

  it("l'identité change avec le pilote, ffmpeg ou les règles — jamais d'autres octets sous la même adresse", () => {
    const a = lightRungs(heavy(), encoder)[0].cid;
    expect(lightRungs(heavy(), { ...encoder, driver: "Intel iHD driver 26.3.0" })[0].cid).not.toBe(a);
    expect(lightRungs(heavy(), { ...encoder, version: "8.2" })[0].cid).not.toBe(a);
    expect(lightRungs(heavy(), encoder)[0].cid).toBe(a);
  });

  it("la taille : réduite pour tenir dans la boîte, proportions gardées, nombres pairs ; jamais agrandie", () => {
    expect(rungSize(3840, 1608, RUNG_SHAPES[0])).toEqual({ width: 1920, height: 804 });
    expect(rungSize(3840, 1916, RUNG_SHAPES[1])).toEqual({ width: 1280, height: 638 });
    expect(rungSize(1440, 1080, RUNG_SHAPES[0])).toEqual({ width: 1440, height: 1080 });
    expect(rungSize(640, 360, RUNG_SHAPES[0])).toEqual({ width: 640, height: 360 });
    expect(rungCodecs(true, 123)).toBe("hvc1.2.4.L123.B0");
  });

  it("la vue : rien sans contexte (option coupée, pas d'encodeur), l'index lui-même pour une source légère", () => {
    expect(withLight(heavy(), null).light).toBeUndefined();
    expect(withLight(index, encoder)).toBe(index);
    expect(withLight(heavy(), encoder).light?.length).toBe(2);
  });
});

describe("les noms", () => {
  it("`l1x{cid}` et `l2x{cid}` : liste, init, segments ; rien d'autre ne se lit comme un échelon", () => {
    const rendition = { kind: "light" as const, rung: 2 as const, cid: "0123abcd" };
    expect(renditionTag(rendition)).toBe("l2x0123abcd");
    expect(parseLumenPath("l2x0123abcd.m3u8")).toEqual({ kind: "playlist", rendition });
    expect(parseLumenPath("init-l1x0123abcd.mp4")).toEqual({ kind: "init", rendition: { ...rendition, rung: 1 } });
    expect(parseLumenPath(segmentName(rendition, 41))).toEqual({ kind: "segment", rendition, n: 41 });
    for (const bad of ["l3x0123abcd.m3u8", "l1.m3u8", "l1xZZZZZZZZ.m3u8", "l1x0123abc.m3u8"]) expect(parseLumenPath(bad)).toBeNull();
  });

  it("le moteur ne sert un échelon que s'il est dans la vue, sous son identité actuelle", () => {
    const engine = new LumenEngine();
    const viewed = withLight(heavy(), encoder);
    const [l1] = viewed.light!;
    expect(engine.resolve(viewed, `l1x${l1.cid}.m3u8`)).toEqual({ kind: "playlist", rendition: { kind: "light", rung: 1, cid: l1.cid } });
    expect(engine.resolve(viewed, `l1xdeadbeef.m3u8`)).toBeNull();
    expect(engine.resolve(heavy(), `l1x${l1.cid}.m3u8`)).toBeNull();
    // Sa liste média : les mêmes segments, les mêmes durées que la vidéo d'origine.
    const media = engine.playlist(viewed, { kind: "light", rung: 1, cid: l1.cid });
    const origin = engine.playlist(viewed, { kind: "video" });
    expect(media.replaceAll(`l1x${l1.cid}`, "v")).toBe(origin);
  });
});

describe("la liste maître", () => {
  it("sans échelon, la liste d'avant à l'octet près", () => {
    const before = masterPlaylist(index, { audioTrack: null, labels });
    expect(masterPlaylist(index, { audioTrack: null, labels, light: { rungs: [] } })).toBe(before);
    expect(masterPlaylist(withLight(index, encoder), { audioTrack: null, labels })).toBe(before);
  });

  it("l'origine d'abord, puis les échelons — même groupe son, débits honnêtes (son compris), leur taille et leur codec", () => {
    const viewed = withLight(heavy(), encoder);
    const text = masterPlaylist(viewed, { audioTrack: null, labels, light: { rungs: viewed.light! } });
    const variants = text.split("\n").filter((l, i, all) => l.startsWith("#EXT-X-STREAM-INF:") && all[i + 1]);
    const uris = text.split("\n").filter((l) => /\.m3u8$/.test(l) && !l.startsWith("#"));
    expect(uris[0]).toBe("v.m3u8");
    expect(uris.slice(1)).toEqual(viewed.light!.map((r) => `l${r.rung}x${r.cid}.m3u8`));
    const l1 = variants[1];
    expect(l1).toContain(`BANDWIDTH=${9_000_000 + 768_000}`);
    expect(l1).toContain(`AVERAGE-BANDWIDTH=${6_000_000 + 768_000}`);
    expect(l1).toContain(`RESOLUTION=${viewed.light![0].width}x${viewed.light![0].height}`);
    expect(l1).toContain("hvc1.1.6.L123.B0");
    expect(l1).not.toContain("SUPPLEMENTAL-CODECS");
    const group = (line: string) => /AUDIO="([^"]+)"/.exec(line)?.[1];
    expect(new Set(variants.map(group)).size).toBe(1);
  });

  it("`?lv=2` met l'échelon 2 en tête (Safari démarre sur lui) ; `?light=seul1` ne sert que lui (le banc)", () => {
    const viewed = withLight(heavy(), encoder);
    const uris = (text: string) => text.split("\n").filter((l) => /\.m3u8$/.test(l) && !l.startsWith("#"));
    const first = masterPlaylist(viewed, { audioTrack: null, labels, light: { rungs: viewed.light!, ...lightOrder(new URLSearchParams("lv=2")) } });
    expect(uris(first)[0]).toBe(`l2x${viewed.light![1].cid}.m3u8`);
    expect(uris(first)[1]).toBe("v.m3u8");
    const only = masterPlaylist(viewed, { audioTrack: null, labels, light: { rungs: viewed.light!, ...lightOrder(new URLSearchParams("light=seul1")) } });
    expect(uris(only)).toEqual([`l1x${viewed.light![0].cid}.m3u8`]);
    expect(lightOrder(new URLSearchParams("lv=3&light=tout"))).toEqual({});
  });

  it("`bw=bas` ne divise que la variante d'origine : les échelons gardent leurs débits honnêtes", () => {
    const viewed = withLight(heavy(), encoder);
    const text = masterPlaylist(viewed, { audioTrack: null, labels, light: { rungs: viewed.light! } });
    const low = withMasterTrials(text, masterTrialOptions(new URLSearchParams("bw=bas")));
    const lines = (t: string) => t.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF:"));
    expect(lines(low)[0]).toContain(`BANDWIDTH=${Math.round(40_000_000 / 4)}`);
    expect(lines(low).slice(1)).toEqual(lines(text).slice(1));
  });
});

describe("le flux de l'encodeur", () => {
  it("les images : une par première tranche, paramètres et SEI préfixes avec elle, AUD retirées", () => {
    const vps = nal(32, 1);
    const sps = nal(33, 2);
    const pps = nal(34, 3);
    const aud = nal(35, 0x50);
    const idr = nal(19, 0x80, 9);
    const sei = nal(39, 4);
    const p1 = nal(1, 0x80, 7);
    const p1b = nal(1, 0x00, 8); // deuxième tranche de la même image
    const p2 = nal(1, 0x80, 6);
    const pictures = hevcPictures(annexBUnits(annexB([aud, vps, sps, pps, sei, idr, aud, p1, p1b, aud, p2])));
    expect(pictures.length).toBe(3);
    expect(pictures[0].map((u) => u[0] >> 1)).toEqual([32, 33, 34, 39, 19]);
    expect(pictures[1].length).toBe(2);
    expect(isIdrPicture(pictures[0])).toBe(true);
    expect(isIdrPicture(pictures[1])).toBe(false);
    expect([...lengthPrefixed([Uint8Array.of(1, 2)])]).toEqual([0, 0, 0, 2, 1, 2]);
  });

  it("le `hvcC` refait depuis les paramètres d'un vrai flux : le même profil, le même niveau, le même CODECS", () => {
    const record = index.video!.codecPrivate;
    const units: Uint8Array[] = [];
    let at = 23;
    for (let a = 0; a < record[22]; a++) {
      const count = (record[at + 1] << 8) | record[at + 2];
      at += 3;
      for (let k = 0; k < count; k++) {
        const length = (record[at] << 8) | record[at + 1];
        units.push(record.subarray(at + 2, at + 2 + length));
        at += 2 + length;
      }
    }
    const find = (type: number) => units.find((u) => ((u[0] >> 1) & 0x3f) === type)!;
    const rebuilt = hvcCFromParameterSets(find(32), find(33), find(34));
    expect([...rebuilt.subarray(1, 13)]).toEqual([...record.subarray(1, 13)]);
    expect(hevcCodecString(rebuilt)).toBe(hevcCodecString(record));
    const sps = readHevcSps(find(33));
    expect({ width: sps.width, height: sps.height }).toEqual({ width: index.video!.width, height: index.video!.height });
  });

  it("les instants que l'encodeur reçoit (`-stats_enc_pre`), ramenés en ms quelle que soit la base de temps", () => {
    const stderr = "lumen-frame 0 600016 1/1000\nlumen-frame 1 54005400 1/90000\nautre ligne\n";
    expect(firstEncodedMs(stderr)).toBe(600016);
    expect(encodedFramesMs(stderr)).toEqual([600016, 600060]);
  });

  it("les arguments : la clé d'avant décodée par le iGPU, ni image B ni cadence imposée, le niveau de l'échelon, jamais de shell", () => {
    const rung = lightRungs(heavy(), encoder)[0];
    const args = encodeArgs("/mnt/media/video/film.mkv", rung, 600_016_000, 96);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("-ss")).toBe("600.015500");
    expect(at("-frames:v")).toBe("96");
    expect(at("-bf")).toBe("0");
    expect(at("-fps_mode")).toBe("passthrough");
    expect(at("-level")).toBe("123");
    expect(at("-seek_timestamp")).toBe("1");
    expect(at("-protocol_whitelist")).toBe("file");
    expect(args[args.length - 1]).toBe("pipe:1");
  });
});

describe("le segment allégé", () => {
  it("les instants de l'origine, son départ et sa fin ; une image de trop ou de moins, ou pas d'IDR : une erreur", async () => {
    const file = await openMediaFile(source);
    const n = 0;
    const originBytes = (await buildSegment(source, file, segmentSpec(index, { kind: "video" }, n))).bytes;
    const origin = originTimes(originBytes);
    const next = originTimes((await buildSegment(source, file, segmentSpec(index, { kind: "video" }, n + 1))).bytes);
    // L'origine finit où le segment suivant commence.
    expect(origin.endDecode).toBe(next.startDecode);
    const count = origin.presentations.length;
    const stream = (idrFirst: boolean, pictures: number) =>
      annexB(Array.from({ length: pictures }, (_, i) => (i === 0 ? [nal(32, 1), nal(33, 2), nal(34, 3), nal(idrFirst ? 19 : 1, 0x80, 1)] : [nal(1, 0x80, i)])).flat());
    const built = lightSegment(stream(true, count), origin, n, index.delayUs);
    expect(built.samples).toBe(count);
    const fragments = parseFragments(built.bytes);
    const samples = fragments.flatMap((f) => f.samples);
    expect(fragments[0].baseDecode).toBe(origin.startDecode);
    // Présentation = décodage + D, l'instant de l'image d'origine ; la dernière finit où l'origine finit.
    expect(samples.map((s) => s.decode + s.cto)).toEqual(origin.presentations);
    const last = samples[samples.length - 1];
    expect(last.decode + last.duration).toBe(origin.endDecode);
    expect(fragments.map((f) => f.sequence)).toEqual(fragments.map((_, k) => n * 1000 + k + 1));
    expect(() => lightSegment(stream(true, count + 1), origin, n, index.delayUs)).toThrow(/images encodées/);
    expect(() => lightSegment(stream(false, count), origin, n, index.delayUs)).toThrow(/IDR/);
  });
});

describe("la page", () => {
  const rungs = [
    { rung: 1 as const, height: 1080, averageBps: 8_768_000, peakBps: 12_768_000 },
    { rung: 2 as const, height: 720, averageBps: 3_768_000, peakBps: 5_268_000 },
  ];
  it("l'échelon d'une connexion faible : le meilleur qui passe avec de la marge, sinon le plus léger ; rien quand la connexion porte le film", () => {
    expect(lightRungFor(null, 25e6, rungs)).toBeNull();
    expect(lightRungFor(40, 25e6, rungs)).toBeNull();
    expect(lightRungFor(20, 25e6, rungs)).toBe(1);
    expect(lightRungFor(10, 25e6, rungs)).toBe(2);
    expect(lightRungFor(2, 25e6, rungs)).toBe(2);
    expect(lightRungFor(2, 25e6, [])).toBeNull();
    expect(withLightFirst("/m.m3u8?audio=2#t=600", 2)).toBe("/m.m3u8?audio=2&lv=2#t=600");
  });

  it("le temps par hauteur d'image : rien sans bascule, la plus longue d'abord sinon", () => {
    const tally = new QualityTally();
    expect(tally.note(1608, 0)).toBe(false);
    expect(tally.fields(10_000)).toEqual({});
    expect(tally.note(804, 60_000)).toBe(true);
    expect(tally.note(804, 61_000)).toBe(false);
    expect(tally.fields(90_000)).toEqual({ quality: "1608:60 804:30", qualitySwitches: 1 });
  });
});

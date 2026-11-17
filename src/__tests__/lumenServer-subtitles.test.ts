import { describe, it, expect } from "vitest";
import {
  chosenSubtitle,
  isCarriableSubtitle,
  LUMEN_SUBTITLE_GROUP,
  parseSubtitleParam,
  parseSubtitlePath,
  parseVttCues,
  subtitleMediaPlaylist,
  subtitleRenditionTag,
  subtitleSegment,
  timestampMap,
  vttTimestamp,
  withSubtitleRendition,
  type LumenSubtitleTrack,
} from "@/lib/lumenServer/subtitles";
import { mediaPlaylist } from "@/lib/lumenServer/playlists";
import type { LumenIndex, LumenSegment } from "@/lib/lumenServer/format";

// Les sous-titres de Lumen serveur dans le flux HLS (DECISIONS.md §191) : les règles pures, une à une — le nom d'un
// rendu et ce qui le fait changer, la ligne de la liste maître, la liste média sur la grille de la vidéo, la lecture
// du WebVTT de Jellyfin, la découpe (une réplique à cheval dans les deux segments) et `X-TIMESTAMP-MAP`.

const track = (extra: Partial<LumenSubtitleTrack> = {}): LumenSubtitleTrack => ({
  index: 3,
  language: "fre",
  title: null,
  codec: "subrip",
  isDefault: false,
  isForced: false,
  isHearingImpaired: false,
  isExternal: false,
  path: null,
  isText: true,
  sync: null,
  ...extra,
});

const seg = (startUs: number, endUs: number): LumenSegment => ({ startUs, endUs, keyUs: startUs, at: 0, bytes: 0 });
/** Trois segments : 0–4,004 s, 4,004–10,427083 s, 10,427083–12 s. */
const SEGMENTS = [seg(0, 4_004_000), seg(4_004_000, 10_427_083), seg(10_427_083, 12_000_000)];

const MASTER = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ec-3",LANGUAGE="fr",NAME="Français",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6",URI="a2.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=5000000,CODECS="hvc1.2.4.L120.90,ec-3",VIDEO-RANGE=PQ,RESOLUTION=3840x2160,FRAME-RATE=23.976,AUDIO="aud-ec-3"',
  "v.m3u8",
  "",
].join("\n");

describe("le nom d'un rendu", () => {
  it("`s{index}h{empreinte}`, stable, et lu par `parseSubtitlePath` seul (strict)", () => {
    const tag = subtitleRenditionTag("abc", track());
    expect(tag).toMatch(/^s3h[0-9a-f]{8}$/);
    expect(subtitleRenditionTag("ABC", track())).toBe(tag);
    expect(parseSubtitlePath(`${tag}.m3u8`)).toEqual({ kind: "playlist", tag, index: 3 });
    expect(parseSubtitlePath(`${tag}/12.vtt`)).toEqual({ kind: "segment", tag, index: 3, n: 12 });
    for (const bad of ["s03h12345678.m3u8", "s3h1234567.m3u8", "s3hABCDEF12.m3u8", `${tag}/01.vtt`, `${tag}/-1.vtt`, `${tag}/1.m4s`, "v.m3u8", "a2/1.m4s", `${tag}.m3u8x`]) {
      expect(parseSubtitlePath(bad), bad).toBeNull();
    }
  });

  it("l'empreinte change avec ce qui fait les octets : la source, la piste, le fichier à côté, la version de la synchro", () => {
    const base = subtitleRenditionTag("src", track());
    const changed = [
      subtitleRenditionTag("autre", track()),
      subtitleRenditionTag("src", track({ codec: "ass" })),
      subtitleRenditionTag("src", track({ language: "eng" })),
      subtitleRenditionTag("src", track({ title: "SDH" })),
      subtitleRenditionTag("src", track({ isForced: true })),
      subtitleRenditionTag("src", track({ isExternal: true, path: "/m/a.fr.srt" })),
      subtitleRenditionTag("src", track({ isExternal: true, path: "/m/b.fr.srt" })),
      subtitleRenditionTag("src", track({ sync: { offset: 1, scale: 1, version: 1 } })),
      subtitleRenditionTag("src", track({ sync: { offset: 1, scale: 1, version: 2 } })),
    ];
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
  });

  it("`?st=` : un index, `premier`, rien, ou mal formé", () => {
    expect(parseSubtitleParam(null)).toBeUndefined();
    expect(parseSubtitleParam("")).toBeUndefined();
    expect(parseSubtitleParam("0")).toBe(0);
    expect(parseSubtitleParam("12")).toBe(12);
    expect(parseSubtitleParam("premier")).toBe("premier");
    for (const bad of ["03", "-1", "1.5", "abc", "12345"]) expect(parseSubtitleParam(bad), bad).toBeNull();
  });

  it("ce que ce chemin porte : du texte seulement — ni une piste en images, ni un index négatif (génération)", () => {
    expect(isCarriableSubtitle(track())).toBe(true);
    expect(isCarriableSubtitle(track({ isText: null }))).toBe(true);
    expect(isCarriableSubtitle(track({ isText: false }))).toBe(false);
    expect(isCarriableSubtitle(track({ codec: "PGSSUB", isText: null }))).toBe(false);
    expect(isCarriableSubtitle(track({ codec: "dvd_subtitle" }))).toBe(false);
    expect(isCarriableSubtitle(track({ index: -2 }))).toBe(false);
    const tracks = [track({ index: 2, codec: "pgssub", isText: false }), track({ index: 3 }), track({ index: 5 })];
    expect(chosenSubtitle(tracks, "premier")?.index).toBe(3);
    expect(chosenSubtitle(tracks, 5)?.index).toBe(5);
    expect(chosenSubtitle(tracks, 2)).toBeNull();
    expect(chosenSubtitle(tracks, 9)).toBeNull();
  });
});

describe("la liste maître", () => {
  it("la ligne du rendu avant la première variante, `SUBTITLES` sur la variante, le reste octet pour octet", () => {
    const tag = subtitleRenditionTag("src", track());
    const out = withSubtitleRendition(MASTER, { tag, track: track(), name: "Français — Complets" });
    const lines = out.split("\n");
    const media = `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${LUMEN_SUBTITLE_GROUP}",LANGUAGE="fr",NAME="Français — Complets",DEFAULT=YES,AUTOSELECT=YES,URI="${tag}.m3u8"`;
    expect(lines[2]).toBe(media);
    expect(lines[3]).toBe(`${MASTER.split("\n")[2]},SUBTITLES="subs"`);
    expect(out.replace(`${media}\n`, "").replace(',SUBTITLES="subs"', "")).toBe(MASTER);
    // L'URI est relative : sous `…/tv.{jeton}/`, le téléviseur hérite du laissez-passer, segments compris.
    const master = "https://cine.example/api/lumen/i/6-x/s1/tv.AAA.BBB/master.m3u8?audio=2&st=3";
    const list = new URL(`${tag}.m3u8`, master);
    expect(list.pathname).toBe(`/api/lumen/i/6-x/s1/tv.AAA.BBB/${tag}.m3u8`);
    expect(new URL(`${tag}/4.vtt`, list).pathname).toBe(`/api/lumen/i/6-x/s1/tv.AAA.BBB/${tag}/4.vtt`);
  });

  it("forcé : FORCED=YES (drapeau ou titre) ; malentendants : les CHARACTERISTICS d'Apple ; guillemets écartés du nom", () => {
    const forced = withSubtitleRendition(MASTER, { tag: "s5h00000000", track: track({ isForced: true }), name: "F" });
    expect(forced).toMatch(/DEFAULT=YES,AUTOSELECT=YES,FORCED=YES,URI=/);
    expect(withSubtitleRendition(MASTER, { tag: "s5h00000000", track: track({ title: "Forced" }), name: "F" })).toContain("FORCED=YES");
    const sdh = withSubtitleRendition(MASTER, { tag: "s6h00000000", track: track({ isHearingImpaired: true, language: null }), name: 'Piste "6"' });
    expect(sdh).toContain('CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound"');
    expect(sdh).toContain('LANGUAGE="und"');
    expect(sdh).toContain(`NAME="Piste '6'"`);
  });

  it("chaque variante est nommée (l'essai par codec en a plusieurs) ; sans variante, rien ne change", () => {
    const two = `${MASTER}#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud-ac-3"\nv.m3u8\n`;
    const out = withSubtitleRendition(two, { tag: "s3h00000000", track: track(), name: "x" });
    expect(out.match(/#EXT-X-STREAM-INF:[^\n]*/g)!.every((l) => l.endsWith(',SUBTITLES="subs"'))).toBe(true);
    expect(out.match(/TYPE=SUBTITLES/g)).toHaveLength(1);
    expect(withSubtitleRendition("#EXTM3U\n", { tag: "s3h00000000", track: track(), name: "x" })).toBe("#EXTM3U\n");
  });
});

describe("la liste média d'un rendu", () => {
  it("les mêmes EXTINF et la même durée cible que la vidéo, un WebVTT par segment, sans EXT-X-MAP", () => {
    const tag = "s3h0a1b2c3d";
    const text = subtitleMediaPlaylist(SEGMENTS, tag);
    const video = mediaPlaylist({ segments: SEGMENTS, cut: "cra" } as unknown as LumenIndex, { kind: "video" });
    const timing = (t: string) => t.split("\n").filter((l) => l.startsWith("#EXTINF") || l.startsWith("#EXT-X-TARGETDURATION"));
    expect(timing(text)).toEqual(timing(video));
    expect(text.split("\n").filter((l) => l.endsWith(".vtt"))).toEqual([`${tag}/0.vtt`, `${tag}/1.vtt`, `${tag}/2.vtt`]);
    expect(text).not.toContain("EXT-X-MAP");
    expect(text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(text.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});

describe("le WebVTT de Jellyfin", () => {
  it("les répliques seules : en-tête, NOTE, STYLE, identifiants écartés ; CRLF, BOM, `mm:ss`, virgule ; triées", () => {
    const vtt = [
      "﻿WEBVTT - Jellyfin",
      "X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000",
      "",
      "STYLE",
      "::cue { color: yellow }",
      "",
      "NOTE une note",
      "",
      "2",
      "00:01:02.500 --> 00:01:04.000 line:90% align:center",
      "Deuxième",
      "ligne",
      "",
      "1",
      "00:05.000 --> 00:06,25",
      "<i>Première</i>",
      "",
      "00:00:07.000 --> 00:00:07.000",
      "sans durée",
      "",
      "00:00:08.000 --> 00:00:09.000",
      "",
    ].join("\r\n");
    expect(parseVttCues(vtt)).toEqual([
      { startMs: 5000, endMs: 6250, settings: "", text: "<i>Première</i>" },
      { startMs: 62_500, endMs: 64_000, settings: "line:90% align:center", text: "Deuxième\nligne" },
    ]);
  });

  it("un `-->` dans le texte ne casse pas la réplique", () => {
    expect(parseVttCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\na --> b")[0].text).toBe("a → b");
  });

  it("`hh:mm:ss.mmm` partout, au-delà de l'heure", () => {
    expect(vttTimestamp(0)).toBe("00:00:00.000");
    expect(vttTimestamp(3_723_004)).toBe("01:02:03.004");
    expect(vttTimestamp(-5)).toBe("00:00:00.000");
  });
});

describe("la découpe en segments", () => {
  const cues = parseVttCues(
    [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:01.000",
      "Au tout début",
      "",
      "00:00:03.500 --> 00:00:04.500",
      "À cheval sur 0 et 1",
      "",
      "00:00:05.000 --> 00:00:06.000",
      "Dans 1",
      "",
      "00:00:04.004 --> 00:00:04.300",
      "Pile à la frontière",
      "",
      "00:00:09.000 --> 00:00:13.000",
      "De 1 jusqu'après la fin annoncée",
      "",
      "00:00:20.000 --> 00:00:21.000",
      "Après la durée",
    ].join("\n")
  );
  const textsOf = (vtt: string) => vtt.split("\n\n").slice(1).map((b) => b.split("\n")[1]).filter(Boolean);

  it("une réplique à cheval sur une frontière est dans les deux segments, entière et identique", () => {
    const s0 = subtitleSegment(cues, SEGMENTS, 0, 125_000);
    const s1 = subtitleSegment(cues, SEGMENTS, 1, 125_000);
    expect(textsOf(s0)).toEqual(["Au tout début", "À cheval sur 0 et 1"]);
    expect(textsOf(s1)).toEqual(["À cheval sur 0 et 1", "Pile à la frontière", "Dans 1", "De 1 jusqu'après la fin annoncée"]);
    const block = (vtt: string) => vtt.split("\n\n").find((b) => b.includes("À cheval"));
    expect(block(s0)).toBe(block(s1));
    expect(block(s0)).toBe("00:00:03.500 --> 00:00:04.500\nÀ cheval sur 0 et 1");
  });

  it("le dernier segment prend tout ce qui dépasse la durée ; chaque réplique est au moins dans un segment", () => {
    const all = SEGMENTS.map((_, n) => subtitleSegment(cues, SEGMENTS, n, 0));
    expect(textsOf(all[2])).toEqual(["De 1 jusqu'après la fin annoncée", "Après la durée"]);
    for (const cue of cues) expect(all.some((s) => s.includes(cue.text)), cue.text).toBe(true);
  });

  it("un segment sans réplique : l'en-tête seul, un WebVTT valable", () => {
    expect(subtitleSegment([], SEGMENTS, 1, 125_000)).toBe("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:11250,LOCAL:00:00:00.000\n\n");
    expect(() => subtitleSegment([], SEGMENTS, 3, 0)).toThrow();
  });

  it("`X-TIMESTAMP-MAP` : l'instant 0 du fichier est l'instant D du flux, en 90 kHz", () => {
    // D = 125 ms (trois images et le réordonnancement) : 0,125 × 90 000 = 11 250.
    expect(timestampMap(125_000)).toBe("X-TIMESTAMP-MAP=MPEGTS:11250,LOCAL:00:00:00.000");
    expect(timestampMap(41_667)).toBe("X-TIMESTAMP-MAP=MPEGTS:3750,LOCAL:00:00:00.000");
    expect(timestampMap(0)).toBe("X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000");
    // Chaque segment porte la même correspondance : ils ne dépendent pas les uns des autres.
    const maps = SEGMENTS.map((_, n) => subtitleSegment(cues, SEGMENTS, n, 125_000).split("\n")[1]);
    expect(new Set(maps).size).toBe(1);
  });

  it("sans état : un segment produit seul est le même qu'en suite", () => {
    const once = SEGMENTS.map((_, n) => subtitleSegment(cues, SEGMENTS, n, 125_000));
    expect(subtitleSegment(cues, SEGMENTS, 1, 125_000)).toBe(once[1]);
  });
});

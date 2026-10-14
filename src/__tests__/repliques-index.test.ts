import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { subtitleMatroska } from "./helpers/subtitleMatroska";
import { FileByteSource } from "@/lib/repliques/fileSource";
import { bestTextTrack, openMatroskaText, readTextTracks } from "@/lib/repliques/mkvText";
import { indexFilm } from "@/lib/repliques/indexFilm";
import { bestSidecar, decodeSubtitleBytes, describeSidecarName, listSidecars, parseAssFile } from "@/lib/repliques/sidecar";
import { displayText, normalizedText } from "@/lib/repliques/text";
import { languageCode, languagesForFilm } from "@/lib/repliques/languages";

/**
 * L'indexation des répliques, sur de vrais octets (DECISIONS.md §88) : un Matroska fabriqué en
 * mémoire, écrit dans un dossier temporaire et lu par le même chemin que la production — l'index
 * d'abord, la lecture complète en repli, les fichiers posés à côté avant tout.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repliques-index-"));
const SECONDS = 40;
const FR: [number, number, string][] = [
  [2, 1500, "<i>Je suis ton père.</i>"],
  [5, 2000, "Personne ne bouge !"],
  [9, 1800, "{\\an8}On va avoir besoin\nd'un plus gros bateau."],
  [30, 1200, "Au revoir."],
];
const EN: [number, number, string][] = [
  [2, 1500, "0,0,Default,,0,0,0,,I am your {\\i1}father{\\i0}."],
  [5, 2000, "0,0,Default,,0,0,0,,Nobody move!\\NNow."],
];
const FORCED: [number, number, string][] = [[3, 1000, "PANNEAU"]];

function write(name: string, bytes: Uint8Array): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

let indexed: string;
let unindexed: string;
let wide: string;

beforeAll(() => {
  indexed = write("Film (2001)/Film (2001).mkv", subtitleMatroska(SECONDS, [
    { number: 2, codec: "S_TEXT/UTF8", language: "fre", lines: FR },
    { number: 3, codec: "S_TEXT/ASS", language: "eng", lines: EN, blockGroup: true },
    { number: 4, codec: "S_TEXT/UTF8", language: "fre", name: "Forcés", forced: true, lines: FORCED },
  ], 60_000));
  unindexed = write("Vieux (1990)/Vieux (1990).mkv", subtitleMatroska(SECONDS, [
    { number: 2, codec: "S_TEXT/UTF8", language: "fre", lines: FR, unindexed: true, blockGroup: true },
  ]));
  wide = write("Large (2010)/Large (2010).mkv", subtitleMatroska(SECONDS, [{ number: 2, codec: "S_TEXT/UTF8", language: "fre", lines: FR }], 2000, true));
});

describe("lecture ciblée par l'index", () => {
  it("décrit les pistes texte et compte ce que l'index désigne pour chacune", async () => {
    const source = await FileByteSource.open(indexed);
    const text = await openMatroskaText(source);
    source.close();
    expect(text.tracks.map((t) => [t.number, t.language, t.forced, t.indexed])).toEqual([
      [2, "fr", false, 4],
      [3, "en", false, 2],
      [4, "fr", true, 1],
    ]);
  });

  it("lit chaque réplique à sa place, sans lire le film autour", async () => {
    const source = await FileByteSource.open(indexed);
    const text = await openMatroskaText(source);
    const scans: string[] = [];
    const result = await readTextTracks(source, text, [2, 3], async () => {
      scans.push("scan");
      return source;
    });
    expect(scans).toEqual([]);
    expect(result.scanned).toEqual([]);
    expect(result.lines.get(2)).toEqual([
      { startMs: 2250, endMs: 3750, text: "Je suis ton père." },
      { startMs: 5250, endMs: 7250, text: "Personne ne bouge !" },
      { startMs: 9250, endMs: 11050, text: "On va avoir besoin\nd'un plus gros bateau." },
      { startMs: 30250, endMs: 31450, text: "Au revoir." },
    ]);
    // L'ASS : le texte après ses champs, \N en retour à la ligne, balises retirées ; durée du BlockGroup.
    expect(result.lines.get(3)).toEqual([
      { startMs: 2250, endMs: 3750, text: "I am your father." },
      { startMs: 5250, endMs: 7250, text: "Nobody move!\nNow." },
    ]);
    // Le film fait ~2,4 Mo d'image : la lecture ciblée n'en lit qu'une fraction.
    expect(source.bytesRead).toBeLessThan(fs.statSync(indexed).size / 4);
    source.close();
  });

  it("devine la largeur de la taille de grappe (8 octets, à la ffmpeg)", async () => {
    const source = await FileByteSource.open(wide);
    const text = await openMatroskaText(source);
    const result = await readTextTracks(source, text, [2], async () => {
      throw new Error("pas de lecture complète attendue");
    });
    expect(result.lines.get(2)?.map((l) => l.startMs)).toEqual([2250, 5250, 9250, 30250]);
    source.close();
  });

  it("relit en entier, en flux, une piste que l'index ne désigne pas — mêmes répliques", async () => {
    const source = await FileByteSource.open(unindexed);
    const text = await openMatroskaText(source);
    expect(text.tracks[0].indexed).toBe(0);
    const result = await readTextTracks(source, text, [2], () => FileByteSource.open(unindexed, { chunkBytes: 1 << 20, maxChunks: 4 }));
    source.close();
    expect(result.scanned).toEqual([2]);
    expect(result.lines.get(2)?.map((l) => [l.startMs, l.endMs, l.text])).toEqual([
      [2250, 3750, "Je suis ton père."],
      [5250, 7250, "Personne ne bouge !"],
      [9250, 11050, "On va avoir besoin\nd'un plus gros bateau."],
      [30250, 31450, "Au revoir."],
    ]);
  });
});

describe("le choix de la piste", () => {
  const base = { codecId: "S_TEXT/UTF8", name: null, hearingImpaired: false, forced: false };
  it("écarte une piste forcée seule", () => {
    expect(bestTextTrack([{ ...base, number: 4, language: "fr", forced: true, indexed: 30 }], "fr")).toBeNull();
  });
  it("préfère l'ordinaire à la SDH, mais garde la SDH si elle est la seule complète", () => {
    const sdh = { ...base, number: 5, language: "en", hearingImpaired: true, indexed: 1500 };
    const plain = { ...base, number: 6, language: "en", indexed: 1400 };
    expect(bestTextTrack([sdh, plain], "en")?.number).toBe(6);
    expect(bestTextTrack([sdh, { ...plain, indexed: 40 }], "en")?.number).toBe(5);
  });
});

describe("les fichiers posés à côté", () => {
  it("lit la langue et les drapeaux dans le nom", () => {
    const video = "/m/Film (2001)/Film (2001).mkv";
    expect(describeSidecarName(video, "Film (2001).fr.srt")).toEqual({ language: "fr", forced: false, hearingImpaired: false });
    expect(describeSidecarName(video, "Film (2001).french.forced.srt")).toEqual({ language: "fr", forced: true, hearingImpaired: false });
    expect(describeSidecarName(video, "Film (2001).en.sdh.srt")).toEqual({ language: "en", forced: false, hearingImpaired: true });
    expect(describeSidecarName(video, "Film (2001).VFQ.ass")).toEqual({ language: "fr", forced: false, hearingImpaired: false });
    // Sans langue reconnue, ou d'un autre film : rien.
    expect(describeSidecarName(video, "Film (2001).srt")).toBeNull();
    expect(describeSidecarName(video, "Autre.fr.srt")).toBeNull();
    expect(describeSidecarName(video, "Film (2001).fr.nfo")).toBeNull();
  });

  it("décode un vieux .srt en Windows-1252 sans transformer les accents en « � »", () => {
    expect(decodeSubtitleBytes(new Uint8Array([0x70, 0xe8, 0x72, 0x65]))).toBe("père");
    expect(decodeSubtitleBytes(new TextEncoder().encode("﻿père"))).toBe("père");
  });

  it("lit un fichier ASS d'après sa ligne Format", () => {
    const ass = "[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Salut{\\i0}, toi\\Nici\n";
    expect(parseAssFile(ass)).toEqual([{ startMs: 1500, endMs: 3000, text: "Salut, toi\nici" }]);
  });

  it("prend le fichier posé à côté avant la piste intégrée (repli .srt), la piste pour la langue qui manque", async () => {
    write("Film (2001)/Film (2001).en.srt", new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,500\n<i>Hello there.</i>\n\n2\n00:00:04,000 --> 00:00:05,000\nGeneral Kenobi.\n"));
    write("Film (2001)/Film (2001).en.forced.srt", new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nSIGN\n"));
    const sidecars = await listSidecars(indexed);
    expect(bestSidecar(sidecars, "en")?.file.endsWith(".en.srt")).toBe(true);
    const result = await indexFilm({ itemId: "a".repeat(32), radarrId: 7, title: "Film", file: indexed, languages: ["fr", "en"], sidecars });
    expect(result.sources.map((s) => [s.lang, s.kind, s.lines])).toEqual([
      ["en", "sidecar", 2],
      ["fr", "cues", 4],
    ]);
    const en = result.rows.filter((r) => r.lang === "en");
    expect(en.map((r) => [r.startMs, r.text, r.norm])).toEqual([
      [1000, "Hello there.", "hello there"],
      [4000, "General Kenobi.", "general kenobi"],
    ]);
    expect(result.rows.find((r) => r.startMs === 2250 && r.lang === "fr")?.norm).toBe("je suis ton pere");
  });

  it("n'indexe rien d'une langue sans fichier ni piste texte complète", async () => {
    const result = await indexFilm({ itemId: "b".repeat(32), radarrId: 8, title: "Vieux", file: unindexed, languages: ["de"], sidecars: [] });
    expect(result.rows).toEqual([]);
    expect(result.sources).toEqual([]);
  });
});

describe("le texte", () => {
  it("nettoie les balises pour l'affichage et plie pour l'index", () => {
    expect(displayText("<font color=\"red\">Cœur</font>   brisé", "S_TEXT/UTF8")).toBe("Cœur brisé");
    expect(normalizedText("Cœur BRISÉ, l'été !")).toBe("coeur brise l ete");
  });
  it("ramène les langues à deux lettres, VO comprise", () => {
    expect([languageCode("fre"), languageCode("fra"), languageCode("fr-CA"), languageCode("eng"), languageCode("xx")]).toEqual(["fr", "fr", "fr", "en", null]);
    expect(languagesForFilm("fr,original", "Korean")).toEqual(["fr", "ko"]);
    expect(languagesForFilm("fr,original", "French")).toEqual(["fr"]);
    expect(languagesForFilm("fr,original", null)).toEqual(["fr"]);
  });
});

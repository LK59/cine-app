// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { applyInbandModes, castStaysOnLumen, castSubtitleCarried, castSubtitleWanted, inbandTextTracks, withCastSubtitle } from "@/components/player/lumen/castSubtitles";

// Les décisions pures de l'hôte de Lumen serveur pour le sous-titre porté au téléviseur (DECISIONS.md §191).

const tracks = [
  { index: 3, isText: true },
  { index: 4, isText: false },
  { index: -3, isText: true },
];

describe("le sous-titre que le téléviseur doit dessiner", () => {
  it("une piste de texte de la liste ; ni une image, ni une génération (index négatif), ni une piste inconnue", () => {
    expect(castSubtitleWanted(3, tracks)).toBe(3);
    expect(castSubtitleWanted(null, tracks)).toBeNull();
    expect(castSubtitleWanted(4, tracks)).toBeNull();
    expect(castSubtitleWanted(-3, tracks)).toBeNull();
    expect(castSubtitleWanted(7, tracks)).toBeNull();
  });

  it("« Diffuser » reste sur ce chemin sans sous-titre ou avec un sous-titre portable ; sinon le lecteur serveur", () => {
    expect(castStaysOnLumen(null, tracks)).toBe(true);
    expect(castStaysOnLumen(3, tracks)).toBe(true);
    expect(castStaysOnLumen(4, tracks)).toBe(false);
    expect(castStaysOnLumen(-3, tracks)).toBe(false);
  });
});

describe("l'adresse", () => {
  const master = "/api/lumen/g1/6-abc/S/tv.aaa.bbb/master.m3u8?audio=2";
  it("`st` posé, changé, retiré ; chemin, jeton et piste son intacts ; le fragment jamais gardé", () => {
    expect(withCastSubtitle(master, 7)).toBe(`${master}&st=7`);
    expect(withCastSubtitle(`${master}&st=7`, 9)).toBe(`${master}&st=9`);
    expect(withCastSubtitle(`${master}&st=7`, null)).toBe(master);
    expect(withCastSubtitle(`${master}&st=7#t=600`, 7)).toBe(`${master}&st=7`);
    expect(withCastSubtitle("/api/lumen/g1/6-abc/S/master.m3u8", 0)).toBe("/api/lumen/g1/6-abc/S/master.m3u8?st=0");
    expect(withCastSubtitle("/api/lumen/g1/6-abc/S/master.m3u8?st=2", null)).toBe("/api/lumen/g1/6-abc/S/master.m3u8");
  });

  it("le sous-titre que porte une adresse, fragment ou non", () => {
    expect(castSubtitleCarried(null)).toBeNull();
    expect(castSubtitleCarried(master)).toBeNull();
    expect(castSubtitleCarried(`${master}&st=7#t=600`)).toBe(7);
    expect(castSubtitleCarried(`${master}&st=premier`)).toBeNull();
    expect(castSubtitleCarried(`${master}#st=7`)).toBeNull();
  });
});

describe("les pistes du flux", () => {
  function video(withTracks: number, list: Partial<TextTrack>[]) {
    const el = document.createElement("video");
    for (let i = 0; i < withTracks; i++) el.appendChild(document.createElement("track"));
    Object.defineProperty(el, "textTracks", { get: () => list, configurable: true });
    return el;
  }

  it("ce qu'aucun `<track>` ne porte ; sans `HTMLTrackElement.track`, l'ordre de HTML (éléments d'abord)", () => {
    const list = [{ kind: "subtitles" }, { kind: "subtitles" }, { kind: "subtitles" }] as TextTrack[];
    expect(inbandTextTracks(video(2, list))).toEqual([list[2]]);
    expect(inbandTextTracks(video(0, list))).toEqual(list);
  });

  it("`showing` pour le rendu pendant une diffusion qui le porte, `disabled` partout ailleurs ; une piste de métadonnées toujours éteinte", () => {
    const ours = { kind: "subtitles", mode: "hidden" } as TextTrack;
    const inband = { kind: "subtitles", mode: "showing" } as TextTrack;
    const forced = { kind: "forced", mode: "disabled" } as unknown as TextTrack;
    const meta = { kind: "metadata", mode: "hidden" } as TextTrack;
    const el = video(1, [ours, inband, forced, meta]);
    expect(applyInbandModes(el, false)).toBe(2);
    expect([ours.mode, inband.mode, forced.mode, meta.mode]).toEqual(["hidden", "disabled", "disabled", "disabled"]);
    expect(applyInbandModes(el, true)).toBe(2);
    expect([ours.mode, inband.mode, forced.mode, meta.mode]).toEqual(["hidden", "showing", "showing", "disabled"]);
    expect(applyInbandModes(el, true)).toBe(0);
  });
});

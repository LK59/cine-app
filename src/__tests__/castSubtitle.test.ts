import { describe, it, expect } from "vitest";
import { castSubtitleForAnotherFile, castSubtitleStream, parseCastSubtitle } from "@/lib/castSubtitle";
import { castCarriedTo } from "@/lib/useStableFallback";
import { castSubtitleOf } from "@/components/player/nativeHostHelpers";
import { negotiationBody } from "@/components/player/server/negotiationBody";
import type { PlayerTrack } from "@/lib/webcodecs/playerTrack";

const streams = [
  { Type: "Audio", Index: 1, Language: "jpn" },
  { Type: "Subtitle", Index: 2, Language: "eng", IsTextSubtitleStream: true },
  { Type: "Subtitle", Index: 3, Language: "fre", IsTextSubtitleStream: false },
  { Type: "Subtitle", Index: 4, Language: "fre", IsTextSubtitleStream: true, IsForced: true },
  { Type: "Subtitle", Index: 5, Language: "fre", IsTextSubtitleStream: true },
];

describe("castSubtitleStream", () => {
  it("garde l'index demandé quand il désigne bien un sous-titre de cette langue", () => {
    expect(castSubtitleStream(streams, { index: 3, language: "fra", forced: false })).toBe(3);
  });
  it("retrouve par la langue : le même drapeau d'abord, un texte avant une image", () => {
    expect(castSubtitleStream(streams, { language: "fra", forced: false })).toBe(5);
    expect(castSubtitleStream(streams, { language: "fra", forced: true })).toBe(4);
    expect(castSubtitleStream(streams, { index: 2, language: "fra", forced: false })).toBe(5);
  });
  it("rien sans correspondance, ni sans langue hors de l'index demandé", () => {
    expect(castSubtitleStream(streams, { language: "spa", forced: false })).toBeNull();
    expect(castSubtitleStream(streams, { index: 9, language: null, forced: false })).toBeNull();
    expect(castSubtitleStream(streams, { index: 1, language: null, forced: false })).toBeNull();
    expect(castSubtitleStream(streams, { index: 2, language: null, forced: false })).toBe(2);
  });
});

describe("parseCastSubtitle", () => {
  it("relit une forme valide et ramène la langue au code de Jellyfin", () => {
    expect(parseCastSubtitle({ index: 5, language: "fre", forced: false })).toEqual({ index: 5, language: "fra", forced: false });
    expect(parseCastSubtitle({ language: "fr", forced: true })).toEqual({ language: "fra", forced: true });
  });
  it("refuse le reste", () => {
    expect(parseCastSubtitle(null)).toBeNull();
    expect(parseCastSubtitle({ index: -1 })).toBeNull();
    expect(parseCastSubtitle({ index: 1.5, language: "<script>" })).toBeNull();
  });
});

describe("le relais à l'épisode suivant d'une diffusion", () => {
  it("garde la langue du sous-titre, jamais son index", () => {
    const episode1 = { itemId: "e1", openId: 7 };
    const episode2 = { itemId: "e2", openId: 7 };
    const takeover = { resumeAt: 600, audioStreamIndex: 1, cast: true, owner: episode1, castSubtitle: { index: 5, language: "fra", forced: false } };
    expect(castCarriedTo(takeover, episode2)?.castSubtitle).toEqual({ language: "fra", forced: false });
    expect(castSubtitleForAnotherFile(undefined)).toBeUndefined();
  });
});

describe("castSubtitleOf — le sous-titre que montre le lecteur natif", () => {
  const track = (number: number, language: string | null, isForced = false): PlayerTrack =>
    ({ number, codecId: "S_TEXT/UTF8", language, name: null, isDefault: false, isForced }) as PlayerTrack;
  const fileTracks = [track(10, "fre", true), track(11, "fre")];
  it("une piste du fichier : son index Jellyfin, sa langue, son drapeau", () => {
    expect(castSubtitleOf(11, fileTracks, [4, 5], [], false)).toEqual({ index: 5, language: "fra", forced: false });
    expect(castSubtitleOf(10, fileTracks, [4, 5], [], false)).toEqual({ index: 4, language: "fra", forced: true });
  });
  it("un fichier à côté : l'index de son adresse", () => {
    const externals = [{ id: 900, url: "/api/jellyfin/stream/subtitle/x?mediaSourceId=x&index=7", language: "eng" }];
    expect(castSubtitleOf(900, fileTracks, [4, 5], externals, false)).toEqual({ index: 7, language: "eng", forced: false });
  });
  it("rien sans sous-titre, pendant une génération, ou sans index retrouvé", () => {
    expect(castSubtitleOf(null, fileTracks, [4, 5], [], false)).toBeUndefined();
    expect(castSubtitleOf(11, fileTracks, [4, 5], [], true)).toBeUndefined();
    expect(castSubtitleOf(11, fileTracks, undefined, [], false)).toBeUndefined();
  });
});

describe("negotiationBody — burnSubtitle", () => {
  const base = {
    itemId: "i",
    cap: { maxBitrate: 1, step: null },
    opts: undefined,
    codecSupport: { video: {}, audio: {} },
    disableAudioCodecs: [],
    nativeHls: true,
    bench: undefined,
    scene: false,
  };
  const subtitle = { index: 5, language: "fra", forced: false };
  it("seulement pour une séance de diffusion qui en porte un", () => {
    expect(negotiationBody({ ...base, castSession: true, castSubtitle: subtitle })).toMatchObject({ forCast: true, burnSubtitle: subtitle });
    expect(negotiationBody({ ...base, castSession: false, castSubtitle: subtitle })).not.toHaveProperty("burnSubtitle");
    expect(negotiationBody({ ...base, castSession: true })).not.toHaveProperty("burnSubtitle");
  });
});

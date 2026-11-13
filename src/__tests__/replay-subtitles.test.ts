import { beforeEach, describe, expect, it } from "vitest";
import {
  REPLAY_TAIL_S,
  REPLAY_USAGE_VALUE,
  endReplayUsage,
  extendReplayWindow,
  forgetReplayUsage,
  isReplayRewind,
  noteReplayKept,
  noteReplayShown,
  pickReplaySubtitle,
  replayLogFields,
  type ReplayCandidate,
} from "@/lib/replaySubtitles";

// Les sous-titres d'un passage rejoué (DECISIONS.md §150) : la règle, la fenêtre et le relevé.

const track = (id: number, language: string | null, over: Partial<ReplayCandidate> = {}): ReplayCandidate => ({
  id,
  language,
  name: null,
  isDefault: false,
  isForced: false,
  text: true,
  ...over,
});

const FR_FULL = track(1, "fre");
const FR_FORCED = track(2, "fre", { isForced: true });
const EN_FULL = track(3, "eng");
const EN_FORCED_BY_TITLE = track(4, "eng", { name: "English forced" });
const FR_PGS = track(5, "fre", { text: false });

describe("le déclencheur", () => {
  it("un recul de cinq à quinze secondes, jamais un saut en avant ni un long recul", () => {
    expect(isReplayRewind(-10)).toBe(true);
    expect(isReplayRewind(-5)).toBe(true);
    expect(isReplayRewind(-15)).toBe(true);
    expect(isReplayRewind(-4)).toBe(false);
    expect(isReplayRewind(-30)).toBe(false);
    expect(isReplayRewind(-60)).toBe(false);
    expect(isReplayRewind(10)).toBe(false);
    expect(isReplayRewind(-Infinity)).toBe(false);
  });
});

describe("la piste de l'aide", () => {
  const base = { tracks: [FR_FULL, FR_FORCED, EN_FULL, EN_FORCED_BY_TITLE], second: null, accountLanguages: ["fr"] };

  it("sans sous-titre : le complet dans la langue de l'audio entendu", () => {
    expect(pickReplaySubtitle({ ...base, current: null, audioLanguage: "fre" })).toBe(1);
    expect(pickReplaySubtitle({ ...base, current: null, audioLanguage: "eng" })).toBe(3);
  });

  it("un forcé à l'écran : le complet dans la langue du forcé (VO avec forcés français → complet français)", () => {
    expect(pickReplaySubtitle({ ...base, current: 2, audioLanguage: "eng" })).toBe(1);
    // Forcé reconnu par son seul titre (`isForcedTrack`) : même chose.
    expect(pickReplaySubtitle({ ...base, current: 4, audioLanguage: "fre" })).toBe(3);
  });

  it("un complet déjà à l'écran : rien", () => {
    expect(pickReplaySubtitle({ ...base, current: 1, audioLanguage: "fre" })).toBeNull();
    expect(pickReplaySubtitle({ ...base, current: 3, audioLanguage: "fre" })).toBeNull();
  });

  it("un second sous-titre, ou une piste inconnue (une génération) à l'écran : rien", () => {
    expect(pickReplaySubtitle({ ...base, current: 2, second: 3, audioLanguage: "fre" })).toBeNull();
    expect(pickReplaySubtitle({ ...base, current: 99, audioLanguage: "fre" })).toBeNull();
  });

  it("pas de complet dans la langue de l'audio : celle du compte, puis celle de l'interface ; sinon rien", () => {
    expect(pickReplaySubtitle({ ...base, current: null, audioLanguage: "jpn" })).toBe(1);
    expect(pickReplaySubtitle({ ...base, current: null, audioLanguage: "jpn", accountLanguages: [null, "en"] })).toBe(3);
    expect(pickReplaySubtitle({ ...base, current: null, audioLanguage: "jpn", accountLanguages: ["de", "es"] })).toBeNull();
    expect(pickReplaySubtitle({ ...base, current: null, audioLanguage: null, accountLanguages: [] })).toBeNull();
  });

  it("jamais une piste forcée ni une piste en images comme aide", () => {
    expect(pickReplaySubtitle({ tracks: [FR_FORCED, FR_PGS], current: null, audioLanguage: "fre", accountLanguages: ["fr"] })).toBeNull();
    expect(pickReplaySubtitle({ tracks: [FR_PGS, FR_FULL], current: null, audioLanguage: "fre", accountLanguages: [] })).toBe(1);
  });

  it("une piste ordinaire avant la malentendants, puis celle que le fichier marque par défaut", () => {
    const sdh = track(10, "fre", { isHearingImpaired: true, isDefault: true });
    const plain = track(11, "fre");
    const flagged = track(12, "fre", { isDefault: true });
    expect(pickReplaySubtitle({ tracks: [sdh, plain], current: null, audioLanguage: "fr", accountLanguages: [] })).toBe(11);
    expect(pickReplaySubtitle({ tracks: [sdh, plain, flagged], current: null, audioLanguage: "fr", accountLanguages: [] })).toBe(12);
    expect(pickReplaySubtitle({ tracks: [sdh], current: null, audioLanguage: "fr", accountLanguages: [] })).toBe(10);
  });

  it("une langue écrite de deux façons (fre / fra / fr-FR) ou dite par le seul titre", () => {
    const vff = track(20, null, { name: "VFF" });
    expect(pickReplaySubtitle({ tracks: [vff], current: null, audioLanguage: "fra", accountLanguages: [] })).toBe(20);
    expect(pickReplaySubtitle({ tracks: [FR_FULL], current: null, audioLanguage: "fr-FR", accountLanguages: [] })).toBe(1);
  });
});

describe("la fenêtre", () => {
  it("de la cible jusqu'à la position d'avant le premier recul, plus deux secondes ; chaque recul de plus allonge", () => {
    const first = extendReplayWindow(null, 1, 2550);
    expect(first).toEqual({ track: 1, until: 2550 + REPLAY_TAIL_S });
    // Un second recul une seconde plus tard (de 2541) : la fin reste celle du premier.
    expect(extendReplayWindow(first, 7, 2541)).toEqual({ track: 1, until: 2552 });
    // Un recul après l'avoir dépassée en partie, d'une position plus lointaine : la fin recule d'autant.
    expect(extendReplayWindow(first, 1, 2556)).toEqual({ track: 1, until: 2558 });
  });

  it("rien à ouvrir sans piste ; une fenêtre ouverte s'allonge même si l'hôte n'en propose plus", () => {
    expect(extendReplayWindow(null, null, 100)).toBeNull();
    expect(extendReplayWindow({ track: 3, until: 50 }, null, 100)).toEqual({ track: 3, until: 102 });
  });
});

describe("le relevé du bilan", () => {
  beforeEach(() => forgetReplayUsage());

  it("rien tant qu'aucune aide n'a paru — le bilan reste identique", () => {
    expect(replayLogFields("film")).toEqual({});
  });

  it("aides et gardées, puis zéro à la séance suivante", () => {
    noteReplayShown("film");
    noteReplayShown("film");
    noteReplayKept("film");
    expect(replayLogFields("film")).toEqual({ replaySubs: "a2 g1" });
    expect(REPLAY_USAGE_VALUE.test("a2 g1")).toBe(true);
    endReplayUsage("film");
    expect(replayLogFields("film")).toEqual({});
    noteReplayShown("film");
    expect(replayLogFields("film")).toEqual({ replaySubs: "a1 g0" });
  });

  it("la forme que le serveur accepte, rien d'autre", () => {
    expect(REPLAY_USAGE_VALUE.test("a1000 g0")).toBe(false);
    expect(REPLAY_USAGE_VALUE.test("a1 g1 x")).toBe(false);
  });
});

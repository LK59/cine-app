import { describe, it, expect, vi, beforeEach } from "vitest";

// « Qui parle » (10.30, DECISIONS.md §138–§139) : l'alignement des répliques sur les voix, la règle « analyse
// complète seulement », et ce qui part au modèle.

const svc = vi.hoisted(() => ({
  voices: null as unknown,
  configured: true,
  target: { etag: "v1", durationS: 1800 as number | null },
}));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => svc.configured,
  xray: { voices: async () => svc.voices },
}));
vi.mock("@/lib/xray/cast", () => ({
  analysisTarget: async (itemId: string) => ({ itemId, type: "Episode", path: "/m.mkv", etag: svc.target.etag, seriesId: null, tmdb: { kind: "episode", tvId: 1, season: 1, episode: 8 }, durationS: svc.target.durationS }),
  castOf: async () => [
    { personId: 1, name: "Hannah Waddingham", character: "Rebecca Welton", order: 0, profilePath: null },
    { personId: 2, name: "Jason Sudeikis", character: "Ted Lasso", order: 1, profilePath: null },
  ],
}));
vi.mock("@/lib/xray/rebind", () => ({ keepsAnalysis: () => false }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { cueLine, speakerOf, withSpeakers, SPEAKER_COVER, SPEAKER_MIN_CONFIDENCE, SPEAKER_SHORT_S, type SpeakerSegment } from "@/lib/ask/voices";
import { speakerSegments } from "@/lib/xray/voices";
import { askSources, askSystem, type AskContextInput } from "@/lib/ask/core";
import { sofarSystem } from "@/lib/ask/sofar";
import { parseSrt, type Cue } from "@/lib/recap/core";

const seg = (start: number, end: number, name: string | null, over: Partial<SpeakerSegment> = {}): SpeakerSegment => ({
  start,
  end,
  voiceId: name ? name.length : 99,
  name,
  confidence: 1,
  ...over,
});
const cue = (atS: number, endS: number, text = "Bonjour.", over: Partial<Cue> = {}): Cue => ({ startS: Math.floor(atS), atS, endS, text, ...over });

describe("l'alignement d'une réplique sur les voix", () => {
  it("une voix nommée qui couvre la réplique la nomme", () => {
    expect(speakerOf(cue(10, 12), [seg(9.8, 12.3, "Rebecca Welton")])).toBe("Rebecca Welton");
  });

  it(`moins de ${SPEAKER_COVER * 100} % couverts : sans nom`, () => {
    // 1 s sur 3 s couverte par la voix nommée, le reste sans voix.
    expect(speakerOf(cue(10, 13), [seg(10, 11, "Rebecca Welton")])).toBeNull();
    expect(speakerOf(cue(10, 13), [seg(10, 12.2, "Rebecca Welton")])).toBe("Rebecca Welton");
  });

  it("une autre voix qui en couvre davantage : sans nom, même si la nommée passe le seuil seule", () => {
    expect(speakerOf(cue(10, 14), [seg(10, 12.5, "Rebecca Welton"), seg(12.5, 14.2, null, { voiceId: 5 })])).toBe("Rebecca Welton");
    expect(speakerOf(cue(10, 14), [seg(10, 11.5, "Rebecca Welton"), seg(11.5, 14.2, null, { voiceId: 5 })])).toBeNull();
  });

  it("deux voix d'une même personne s'additionnent", () => {
    expect(speakerOf(cue(10, 14), [seg(10, 11.4, "Ted Lasso", { voiceId: 1 }), seg(11.4, 12.9, "Ted Lasso", { voiceId: 2 }), seg(12.9, 14, null, { voiceId: 3 })])).toBe("Ted Lasso");
  });

  it("une réplique à deux voix (tiret) n'est jamais nommée", () => {
    expect(speakerOf(cue(10, 12, "- Tu viens ? - Non.", { twoSpeakers: true }), [seg(9, 13, "Ted Lasso")])).toBeNull();
    const [c] = parseSrt("1\n00:00:10,000 --> 00:00:12,000\n- Tu viens ?\n- Non.\n");
    expect(c.twoSpeakers).toBe(true);
    const [d] = parseSrt("1\n00:00:10,000 --> 00:00:12,000\n- Tu viens ? Allez.\n");
    expect(d.twoSpeakers).toBeUndefined();
  });

  it(`une confiance sous ${SPEAKER_MIN_CONFIDENCE}, ou un désaccord : sans nom`, () => {
    expect(speakerOf(cue(10, 12), [seg(9, 13, "Ted Lasso", { confidence: SPEAKER_MIN_CONFIDENCE - 0.01 })])).toBeNull();
    expect(speakerOf(cue(10, 12), [seg(9, 13, "Ted Lasso", { conflict: true })])).toBeNull();
  });

  it("une réplique sans fin connue : bornée par la suivante", () => {
    const cues = [{ startS: 10, atS: 10, text: "Un." }, { startS: 11, atS: 11, text: "Deux." }];
    const out = withSpeakers(cues, [seg(10, 11, "Ted Lasso"), seg(11, 13, null, { voiceId: 4 })]);
    expect(out[0].speaker).toBe("Ted Lasso");
    expect(out[1].speaker).toBeUndefined();
  });

  it("sans segments, les répliques telles quelles", () => {
    const cues = [cue(1, 2)];
    expect(withSpeakers(cues, null)).toEqual(cues);
    expect(cueLine({ ...cues[0], speaker: "Ted Lasso" })).toBe("Ted Lasso : Bonjour.");
    expect(cueLine(cues[0])).toBe("Bonjour.");
  });
});

describe("seulement une analyse complète", () => {
  beforeEach(() => {
    svc.configured = true;
    svc.target = { etag: "v1", durationS: 1800 };
  });
  const answer = (complete: boolean, segments: unknown[] = [{ start: 1, end: 3, voiceId: 4, personId: 1, confidence: 1 }]) => ({
    itemId: "a".repeat(32),
    etag: "v1",
    model: "wespeaker_r34",
    version: 1,
    complete,
    analyzedUntil: 1800,
    track: null,
    segments,
  });

  it("pendant l'analyse : rien, les répliques partent sans nom", async () => {
    svc.voices = answer(false);
    expect(await speakerSegments("a".repeat(32))).toBeNull();
  });

  it("finie : les voix jointes à la distribution, nommées comme « À l'écran » les nomme", async () => {
    svc.voices = answer(true, [
      { start: 1, end: 3, voiceId: 4, personId: 1, confidence: 1 },
      { start: 3, end: 5, voiceId: 5, personId: null, confidence: 0, conflict: true },
      { start: 5, end: 6, voiceId: 6, personId: 99, confidence: 1 },
    ]);
    const segs = await speakerSegments("a".repeat(32));
    expect(segs).toEqual([
      { start: 1, end: 3, voiceId: 4, name: "Rebecca Welton", confidence: 1 },
      { start: 3, end: 5, voiceId: 5, name: null, confidence: 0, conflict: true },
      // Nommé ailleurs dans la série, absent de cette distribution : sans nom.
      { start: 5, end: 6, voiceId: 6, name: null, confidence: 1 },
    ]);
  });

  it("option coupée, rien d'analysé, ou un autre fichier : rien", async () => {
    svc.voices = answer(true);
    svc.configured = false;
    expect(await speakerSegments("a".repeat(32))).toBeNull();
    svc.configured = true;
    svc.voices = null;
    expect(await speakerSegments("a".repeat(32))).toBeNull();
    svc.voices = answer(true);
    svc.target = { etag: "v2", durationS: 1800 };
    expect(await speakerSegments("a".repeat(32))).toBeNull();
  });
});

describe("ce qui part au modèle", () => {
  const input = (cues: Cue[]): AskContextInput => ({
    kind: "series",
    title: "Ted Lasso",
    cast: [],
    watchedAll: false,
    episodes: [],
    current: { code: "S01E08", title: "The Diamond Dogs" },
    positionS: 600,
    cues,
  });

  it("des répliques nommées : « Nom : texte », et le titre du bloc le dit", () => {
    const cues = withSpeakers([cue(10, 12, "Je pars."), cue(20, 22, "Pourquoi ?")], [seg(9.9, 12.1, "Rebecca Welton")]);
    const src = askSources(input(cues));
    expect(src.voiced).toBe(true);
    expect(src.text).toContain("Rebecca Welton : Je pars.\nPourquoi ?");
    expect(src.text).toContain("certaines précédées du nom de qui parle");
    const grouped = askSources(input(cues), { scenes: [{ start: 0, end: 100, people: ["Rebecca Welton"] }], strictCut: true });
    expect(grouped.text).toContain("— à l'écran : Rebecca Welton\nRebecca Welton : Je pars.");
  });

  it("sans voix : exactement comme avant", () => {
    const src = askSources(input([cue(10, 12, "Je pars.")]));
    expect(src.voiced).toBeUndefined();
    expect(src.text).toContain("sans le nom de qui parle\nJe pars.");
    expect(askSystem("fr", false)).toBe(askSystem("fr"));
    expect(sofarSystem("fr", true, "series", false)).toBe(sofarSystem("fr", true, "series"));
  });

  it("la règle d'attribution change, et seulement elle — longueur à peu près la même", () => {
    for (const [plain, voiced] of [
      [askSystem("fr"), askSystem("fr", true)],
      [sofarSystem("fr", true, "series"), sofarSystem("fr", true, "series", true)],
      [sofarSystem("fr", true, "movie"), sofarSystem("fr", true, "movie", true)],
    ]) {
      expect(voiced).not.toBe(plain);
      expect(voiced).toContain("Une réplique précédée d'un nom (« Nom : … ») est dite par lui ; d'une réplique sans nom, ne déduis rien sur qui la dit, même juste après une des siennes.");
      expect(voiced).not.toContain("ne disent pas qui parle");
      // Une centaine de caractères au plus sur des consignes de 2 500 à 4 000 : « à peu près la même longueur ».
      expect(Math.abs(voiced.length - plain.length)).toBeLessThan(120);
    }
    // Le film garde ses propres phrases (10.28.0).
    expect(sofarSystem("fr", true, "movie", true)).toContain("synopsis, distribution, et répliques du film");
  });
});

describe("10.30.1 — une réplique courte avalée par le segment de l'autre reste sans nom", () => {
  // *Ted Lasso* S01E09, 3 min 45 (données réelles du service) : Keeley annonce à Ted que la marque garde ses
  // mannequins, Ted répond « Zut. » (1 s), Keeley reprend. Un seul segment de Keeley couvre la réponse de Ted
  // et toute la réplique suivante : 10.30 écrivait « Keeley Jones : Zut. ».
  const segs: SpeakerSegment[] = [
    { start: 223.219, end: 225.299, voiceId: 60, name: "Keeley Jones", confidence: 1 },
    { start: 225.683, end: 231.891, voiceId: 60, name: "Keeley Jones", confidence: 1 },
  ];
  const cues: Cue[] = [
    cue(223.098, 225.1, "Ils préfèrent garder leurs mannequins."),
    cue(225.475, 226.476, "Zut."),
    cue(226.56, 230.689, "Oui, mais s'ils cherchent un type lambda ou s'ils font une campagne satyrique,"),
  ];

  it("« Zut. » : sans nom ; les deux répliques de Keeley gardent le sien", () => {
    const out = withSpeakers(cues, segs);
    expect(out.map((c) => c.speaker)).toEqual(["Keeley Jones", undefined, "Keeley Jones"]);
  });

  it("la même réplique, seule dans son segment : nommée", () => {
    const own: SpeakerSegment[] = [segs[0], { start: 225.4, end: 226.5, voiceId: 7, name: "Ted Lasso", confidence: 1 }, { start: 226.55, end: 231.9, voiceId: 60, name: "Keeley Jones", confidence: 1 }];
    expect(withSpeakers(cues, own).map((c) => c.speaker)).toEqual(["Keeley Jones", "Ted Lasso", "Keeley Jones"]);
  });

  it(`seulement sous ${SPEAKER_SHORT_S} s : une réplique plus longue dans le même segment reste nommée`, () => {
    const long = [cues[0], cue(225.475, 225.475 + SPEAKER_SHORT_S + 0.05, "Zut, alors."), cue(226.7, 230.689, "Oui, mais…")];
    expect(withSpeakers(long, segs)[1].speaker).toBe("Keeley Jones");
  });

  it("un segment qui ne fait qu'effleurer la voisine (moins de la moitié) ne retire rien", () => {
    // Le segment de la courte déborde de 0,5 s sur une voisine de 4 s.
    const brief: SpeakerSegment[] = [{ start: 225.4, end: 227.06, voiceId: 7, name: "Ted Lasso", confidence: 1 }];
    expect(withSpeakers(cues, brief)[1].speaker).toBe("Ted Lasso");
  });

  it("sans voisines données, `speakerOf` garde la règle de 10.30", () => {
    expect(speakerOf(cues[1], segs)).toBe("Keeley Jones");
  });
});

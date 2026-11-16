import { describe, it, expect } from "vitest";
import {
  MUX_PATTERN,
  MUX_SEEKS,
  MUX_SERIES,
  MUX_TITLES,
  PRESETS,
  formatResult,
  planOf,
  resultOf,
  seriesEstimateS,
  summaryBody,
  trialTag,
  type TrialMeasures,
  type TrialResult,
} from "@/components/lumenTest/autoSeries";
import { analyzeMux, checkAudio, compareMetric, expectedAudio, parseMaster, switchTarget, trackOfUri } from "@/components/lumenTest/muxPass";
import { buildCascade, lumenResourceName, segmentsByRendition, summarizeCascades } from "@/components/lumenTest/chronology";
import { muxedMaster } from "@/lib/lumenServer/trials";
import { lumenTestReport } from "@/lib/lumenServer/testReport";

// La passe « son multiplexé » de la page `/lumen-test` (étape 3f de docs/remux-serveur/) : le plan apparié et alterné,
// la liste maître lue par la page (la piste que Safari doit allumer), le verdict contre la dispersion des répétitions,
// les contrôles de non-régression, les arrivées des segments côté page (Resource Timing) et la ligne bornée par le
// serveur. Le branchement sur la page : `lumen-test-page.test.tsx`.

/** Une liste maître de la forme de `masterPlaylist` (playlists.ts) : un groupe AC-3, deux pistes, la 2 par défaut. */
const MASTER = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ac-3",LANGUAGE="fr",NAME="Français — 2.0",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="a2.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ac-3",LANGUAGE="en",NAME="Anglais — 2.0",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="a3.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,AVERAGE-BANDWIDTH=5400000,CODECS="avc1.640028,ac-3",RESOLUTION=1920x1080,FRAME-RATE=23.976,AUDIO="aud-ac-3"',
  "v.m3u8",
  "",
].join("\n");

describe("le plan de la passe « son multiplexé »", () => {
  it("quatre titres variés, chacun trois fois par mode, en A-B-B-A-A-B (en miroir un titre sur deux), Lumen serveur seul", () => {
    expect(planOf("multiplexé")).toBe(MUX_SERIES);
    expect(planOf("multiplexé", "actuel")).toBe(MUX_SERIES);
    expect(MUX_SERIES).toHaveLength(MUX_TITLES.length * MUX_PATTERN.length);
    expect(new Set(MUX_SERIES.map((t) => t.id)).size).toBe(MUX_SERIES.length);
    for (const t of MUX_SERIES) expect(PRESETS.some((p) => p.key === t.key && p.id === t.itemId)).toBe(true);
    expect(MUX_SERIES.every((t) => t.player === "serveur" && t.cut === "cra" && t.targetS === 4 && t.tours.length === 1 && t.tours[0] === MUX_SEEKS)).toBe(true);
    MUX_TITLES.forEach((key, i) => {
      const trials = MUX_SERIES.filter((t) => t.key === key);
      const pattern = trials.map((t) => (t.modes?.mux ? "B" : "A")).join("");
      expect(pattern).toBe(i % 2 === 0 ? "ABBAAB" : "BAABBA");
      expect(trials.filter((t) => t.modes?.mux).map((t) => t.rep)).toEqual([1, 2, 3]);
      expect(trials.filter((t) => !t.modes?.mux).map((t) => t.rep)).toEqual([1, 2, 3]);
      // Les six essais d'un titre sont consécutifs : même réseau, même heure, mêmes positions (graine, titre, parcours 0).
      const first = MUX_SERIES.findIndex((t) => t.key === key);
      expect(MUX_SERIES.slice(first, first + 6).every((t) => t.key === key)).toBe(true);
      // Un changement de piste par essai multiplexé, et le témoin une fois par titre.
      expect(trials.filter((t) => t.audioSwitch).map((t) => `${t.modes?.mux ? "B" : "A"}${t.rep}`).sort()).toEqual(["A1", "B1", "B2", "B3"]);
    });
    expect(MUX_SERIES[0].id).toBe("maison-blanche-serveur-r1");
    expect(MUX_SERIES[1].id).toBe("maison-blanche-serveur-mux-r1");
    // La durée visée : 15 à 18 minutes.
    expect(seriesEstimateS(MUX_SERIES)).toBeGreaterThan(14 * 60);
    expect(seriesEstimateS(MUX_SERIES)).toBeLessThan(18.5 * 60);
  });

  it("chaque ligne porte sa répétition et son mode", () => {
    expect(trialTag("abc123def456", MUX_SERIES[1], 2, 24, { pass: "multiplexé", seed: 7, order: "serveur" })).toEqual({
      serie: "abc123def456",
      trial: "maison-blanche-serveur-mux-r1",
      rank: 2,
      of: 24,
      player: "serveur",
      pass: "multiplexé",
      seed: 7,
      order: "serveur",
      mode: "mux",
      rep: 1,
    });
  });
});

describe("la liste maître lue par la page", () => {
  it("le rendu par défaut du groupe de la variante en tête, le débit annoncé ; multiplexée, la piste sans URI", () => {
    const plain = expectedAudio(MASTER)!;
    expect(plain).toMatchObject({ defaultIndex: 0, streamMbps: 5.4, muxed: false });
    expect(plain.renditions.map((r) => [r.language, r.name, r.uri])).toEqual([
      ["fr", "Français — 2.0", "a2.m3u8"],
      ["en", "Anglais — 2.0", "a3.m3u8"],
    ]);
    const muxed = expectedAudio(muxedMaster(MASTER, 2))!;
    expect(muxed).toMatchObject({ defaultIndex: 0, muxed: true });
    expect(muxed.renditions.map((r) => r.uri)).toEqual([null, "a3.m3u8"]);
    expect(parseMaster(muxedMaster(MASTER, 2)).variants[0].uri).toBe("vm2.m3u8");
    expect(trackOfUri("a3.m3u8")).toBe(3);
    expect(trackOfUri(null)).toBeNull();
    expect(expectedAudio("#EXTM3U\n")).toBeNull();
  });

  it("la piste allumée contre la piste attendue ; sans pistes annoncées, pas de verdict", () => {
    const expected = expectedAudio(MASTER);
    const fr = { language: "fr", label: "Français — 2.0", enabled: true };
    const en = { language: "en", label: "Anglais — 2.0", enabled: false };
    expect(checkAudio(expected, [fr, en])).toEqual({ ok: true, want: "fr:Français — 2.0", got: "fr:Français — 2.0", tracks: ["fr:Français — 2.0", "en:Anglais — 2.0"] });
    expect(checkAudio(expected, [{ ...fr, enabled: false }, { ...en, enabled: true }])).toMatchObject({ ok: false, got: "en:Anglais — 2.0" });
    expect(checkAudio(expected, [])).toEqual({ want: "fr:Français — 2.0" });
    expect(checkAudio(null, [fr])).not.toHaveProperty("ok");
  });

  it("le changement de piste vise une autre langue (un changement qui s'entend), sinon la suivante", () => {
    const t = (language: string, enabled = false) => ({ language, label: language, enabled });
    expect(switchTarget([t("fr", true), t("fr"), t("en")])).toBe(2);
    expect(switchTarget([t("en"), t("fr", true)])).toBe(0);
    expect(switchTarget([t("fr", true), t("fr")])).toBe(1);
    expect(switchTarget([t("fr", true)])).toBe(-1);
  });
});

describe("le verdict contre la dispersion des répétitions", () => {
  it("séparées et au-delà de 50 ms : plus rapide ou plus lent ; qui se chevauchent : le bruit ; trop peu : non jugé", () => {
    expect(compareMetric([1000, 1100, 1050], [700, 760, 720])).toMatchObject({ medNormal: 1050, medMux: 720, diffMs: -330, noiseMs: 100, separated: true, kind: "plus-rapide" });
    expect(compareMetric([1000, 1100, 1050], [700, 760, 720]).verdict).toBe("multiplexé plus rapide de 330 ms (répétitions séparées, dispersion 100 ms)");
    expect(compareMetric([700, 760, 720], [1000, 1100, 1050]).kind).toBe("plus-lent");
    // Un écart de médianes de 250 ms, mais une répétition de chaque côté dans l'autre : rien de déclaré.
    const noisy = compareMetric([1000, 1600, 1050], [700, 1200, 800]);
    expect(noisy).toMatchObject({ kind: "bruit", separated: false, diffMs: -250 });
    expect(noisy.verdict).toBe("pas de différence au-delà du bruit (écart -250 ms, dispersion 600 ms)");
    expect(compareMetric([1000, 1010, 1020], [980, 985, 990]).kind).toBe("minime");
    expect(compareMetric([1000], [700, 720]).kind).toBe("inconnu");
  });

  /** Un essai de la passe, mesuré : première image, six sauts (seeked = reprise − 600), débit, piste au départ. */
  function trialResult(index: number, firstFrameMs: number, advances: number[], extra: Partial<TrialMeasures> = {}): TrialResult {
    const t = MUX_SERIES[index];
    return resultOf(t, index + 1, { status: "ok" }, {
      firstFrameMs,
      seeks: advances.map((a) => ({ ok: true, advanceMs: a, seekedMs: a - 600 })),
      freezes: [],
      errors: [],
      waits: 0,
      quality: { total: 500, dropped: 0, corrupted: 0 },
      audioSwitches: t.audioSwitch ? [{ ms: 300, waited: false, errors: 0, freezes: 0, applied: true, segs: 3 }] : [],
      linkMbps: 80,
      streamMbps: 5.4,
      audioCheck: { ok: true, want: "fr:Français — 2.0", got: "fr:Français — 2.0", tracks: ["fr:Français — 2.0", "en:Anglais — 2.0"] },
      ...extra,
    });
  }

  it("un titre : les trois mesures, la comparaison position par position, le seuil de débit, les contrôles", () => {
    // Maison Blanche : A B B A A B — le multiplexé plus rapide d'image, pareil à la reprise.
    const slow = [1500, 1400, 1600, 1450, 1550, 1500];
    const results = [
      trialResult(0, 1000, slow),
      trialResult(1, 500, [1400, 1500, 1500, 1400, 1600, 1500]),
      trialResult(2, 480, slow, { linkMbps: 20 }),
      trialResult(3, 1100, [1450, 1450, 1500, 1500, 1500, 1450]),
      trialResult(4, 1050, slow),
      trialResult(5, 520, [1500, 1400, 1550, 1450, 1500, 1500]),
    ];
    expect(results[1]).toMatchObject({ rep: 1, mode: "mux", advances: [1400, 1500, 1500, 1400, 1600, 1500], audioSwitch: { ms: 300, applied: true, segs: 3 }, streamMbps: 5.4 });
    const [title] = analyzeMux(results).titles;
    expect(title).toMatchObject({ key: "maison-blanche", streamMbps: 5.4, floorMbps: 30, lowLink: 1, tracksSame: true, regressions: [] });
    expect(title.firstFrame).toMatchObject({ kind: "plus-rapide", diffMs: -550, normal: [1000, 1100, 1050], mux: [500, 480, 520] });
    expect(title.firstFrame.verdict).toContain("1 essai sous 30 Mb/s");
    expect(title.resume.kind).toBe("bruit");
    expect(title.resume).toMatchObject({ positions: 6 });
    expect(title.checks.multiplexé).toMatchObject({ trials: 3, ok: 3, switches: 3, switchTrouble: 0, switchNotApplied: 0, switchMs: 300, switchSegs: 3, audioChecked: 3, audioOk: 3 });
    expect(title.checks.normal.switches).toBe(1);
    expect(title.trials.map((r) => `${r.mode[0]}${r.rep}${r.low ? "!" : ""}`)).toEqual(["n1", "m1", "m2!", "n2", "n3", "m3"]);
  });

  it("ce qui se dégrade en multiplexé est dit : erreurs, piste fausse, changement non appliqué, rien de la nouvelle piste reçu", () => {
    const steady = [1500, 1500, 1500, 1500, 1500, 1500];
    const bad = { applied: false, segs: 0, ms: undefined, waited: true, errors: 1, freezes: 0 };
    const results = [
      trialResult(0, 1000, steady),
      trialResult(1, 1000, steady, { errors: ["code=3 decode"], audioSwitches: [bad], audioCheck: { ok: false, want: "fr:A", got: "en:B", tracks: ["fr:A", "en:B"] } }),
      trialResult(2, 1000, steady, { audioSwitches: [bad] }),
      trialResult(3, 1000, steady),
      trialResult(4, 1000, steady),
      trialResult(5, 1000, steady, { audioSwitches: [bad] }),
    ];
    const analysis = analyzeMux(results);
    expect(analysis.titles[0].regressions).toEqual([
      "erreurs : 1 en multiplexé, 0 en normal",
      "piste au départ fausse : 1/3 essais multiplexés",
      "changement de piste non appliqué : 3/3",
      "changement de piste avec un ennui : 3/3 en multiplexé, 0/1 en normal",
      "aucun segment de la nouvelle piste reçu après le changement",
      "pistes annoncées différentes d'un essai à l'autre",
    ]);
    expect(analysis.overall.regressions).toBe("dégradation vue sur À la Maison Blanche S03E01");
    expect(analysis.overall.firstFrame).toBe("multiplexé sans différence nette sur 1 (sur 1 titre)");
    expect(formatResult(results[1])).toContain("piste au départ FAUSSE (en:B au lieu de fr:A)");
    expect(formatResult(results[1])).toContain("CHANGEMENT DE PISTE NON APPLIQUÉ");
  });

  it("la ligne récapitulative porte le verdict et les deux questions de la passe ; le serveur la relit et la borne", () => {
    const results = MUX_SERIES.slice(0, 6).map((_, i) => trialResult(i, 1000 - (i % 2) * 300, [1500, 1500, 1500, 1500, 1500, 1500]));
    const body = summaryBody("abc123def456", 24, results, { damaged: "non", damagedTitle: "", audioClean: null, audioChanged: "parfois", lipSync: "oui" }, { elapsedS: 1000, stopped: false, pass: "multiplexé", seed: 5, order: "serveur" });
    expect(body.comparison).toEqual([]);
    expect(body.answers).toEqual({ damaged: "non", damagedTitle: undefined, audioClean: null, audioChanged: "parfois", lipSync: "oui" });
    expect(body.mux?.titles).toHaveLength(1);
    const line = lumenTestReport({ kind: "lumen-test", ...JSON.parse(JSON.stringify(body)) }, "louis");
    const mux = line.mux as { titles: { key: string; firstFrame: { kind: string; normal: number[] }; trials: unknown[]; checks: { multiplexé: { switches: number } } }[]; overall: { firstFrame: string } };
    expect(mux.titles[0]).toMatchObject({ key: "maison-blanche", firstFrame: { kind: body.mux!.titles[0].firstFrame.kind, normal: body.mux!.titles[0].firstFrame.normal }, checks: { multiplexé: { switches: 3 } } });
    expect(mux.titles[0].trials).toHaveLength(6);
    expect(mux.overall.firstFrame).toBe(body.mux!.overall.firstFrame);
    // `audioClean` (la question de Ted Lasso) n'est pas posée dans cette passe : null, donc absent de la ligne.
    expect(line.answers).toEqual({ damaged: "non", audioChanged: "parfois", lipSync: "oui" });
    expect((line.auto as { pass: string }).pass).toBe("multiplexé");
    const trials = line.trials as { rep: number; advances: number[]; audioCheck: { ok: boolean }; audioSwitch?: { segs: number } }[];
    expect(trials[1]).toMatchObject({ rep: 1, advances: [1500, 1500, 1500, 1500, 1500, 1500], audioCheck: { ok: true }, audioSwitch: { segs: 3 } });
    // Ce qui n'a pas la forme attendue tombe.
    const bogus = lumenTestReport({ answers: { audioChanged: "peut-être", lipSync: 3 }, mux: { titles: [{ key: "<script>", firstFrame: { kind: "énorme", normal: ["x", 5] } }] }, auto: { rep: 12 } }, "louis");
    expect(bogus.answers).toBeUndefined();
    expect(bogus.auto).toBeUndefined();
    expect((bogus.mux as { titles: Record<string, unknown>[] }).titles[0]).toEqual({ firstFrame: { normal: [5] } });
  });
});

describe("les arrivées des segments côté page (Resource Timing)", () => {
  it("le nom court d'une adresse de Lumen serveur, pour cette lecture seulement ; les segments par rendu", () => {
    const s = "lt0123456789abcdef01";
    expect(lumenResourceName(`https://h/api/lumen/${"a".repeat(32)}/2m1-0123456789ab/${s}/vm2/12.m4s`, s)).toBe("vm2/12.m4s");
    expect(lumenResourceName(`https://h/api/lumen/${"a".repeat(32)}/2-0123456789ab/${s}/master.m3u8?audio=2`, s)).toBe("master.m3u8");
    expect(lumenResourceName(`https://h/api/lumen/${"a".repeat(32)}/2-0123456789ab/ltother/v/1.m4s`, s)).toBeNull();
    expect(lumenResourceName(`https://h/api/lumen/${"a".repeat(32)}/chrono?s=${s}&bytes=4194304`, s)).toBeNull();
    expect(segmentsByRendition([{ name: "vm2/1.m4s", startTime: 0, responseEnd: 1 }, { name: "vm2/2.m4s", startTime: 0, responseEnd: 1 }, { name: "a3/2.m4s", startTime: 0, responseEnd: 1 }, { name: "vm2.m3u8", startTime: 0, responseEnd: 1 }])).toEqual({ vm2: 2, a3: 1 });
  });

  it("la cascade dit quand chaque segment est arrivé en entier, et combien de segments vidéo étaient reçus à seeked et à la reprise", () => {
    const c = buildCascade({ kind: "saut", to: 600, startedAt: 10_000, seekedAt: 10_600, advanceAt: 11_450, endAt: 12_950 }, [], {
      received: [
        { name: "v/90.m4s", startTime: 9_000, responseEnd: 9_100, bytes: 1_000 }, // avant le geste
        { name: "a2/150.m4s", startTime: 10_040, responseEnd: 10_090, bytes: 400_000 },
        { name: "v/150.m4s", startTime: 10_045, responseEnd: 10_420, bytes: 6_000_000 },
        { name: "v/151.m4s", startTime: 10_300, responseEnd: 10_900, bytes: 6_000_000 },
        { name: "v/152.m4s", startTime: 10_700, responseEnd: 11_300 },
        { name: "v/153.m4s", startTime: 11_400, responseEnd: 0 }, // coupée : pas reçue
      ],
    });
    expect(c).toMatchObject({ firstVideoRecvMs: 420, recvSeeked: 1, recvAdvance: 3, recvAdvanceMB: 12 });
    expect(c.rx).toEqual(["+40 a2/150.m4s l50 k391", "+45 v/150.m4s l375 k5859", "+300 v/151.m4s l600 k5859", "+700 v/152.m4s l600", "+1400 v/153.m4s"]);
    // Sans Resource Timing, la cascade ne change pas.
    expect(buildCascade({ kind: "saut", to: 1, startedAt: 0, endAt: 10 }, [], {})).not.toHaveProperty("rx");
    const summary = summarizeCascades([{ ...c, k: "départ" }, { ...c, firstVideoRecvMs: 500, recvAdvance: 4 }, c]);
    expect(summary).toMatchObject({ firstVideoRecvMs: 460, startVideoRecvMs: 420, recvAdvance: 3.5 });
  });
});

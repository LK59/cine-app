import { describe, it, expect } from "vitest";
import {
  FreezeWatch,
  PRESETS,
  SERIES,
  formatResult,
  qualityDelta,
  resultOf,
  runSeries,
  seriesEstimateS,
  seriesProgress,
  summaryBody,
  type Cut,
  type PreparedVerdict,
  type SeriesDriver,
  type StartResult,
  type Trial,
  type TrialOutcome,
  type TrialResult,
} from "@/components/lumenTest/autoSeries";

// « Tout enchaîner » de la page de banc `/lumen-test` (étape 3b de docs/remux-serveur/, DECISIONS §157) : la
// partie sans navigateur. Le plan suit le protocole du README dans son ordre ; un essai qui échoue — refus, pas
// d'image, exception du pilote — n'arrête jamais la série ; chaque essai est envoyé avant le suivant ; « Arrêter »
// finit l'essai en cours et rien après ; un gel (position qui avance sans image présentée) se voit sur une
// horloge factice. Le branchement sur la vraie page est éprouvé par `lumen-test-page.test.tsx`.

describe("le plan de la série", () => {
  it("suit le protocole de l'étape 3b, dans son ordre", () => {
    expect(SERIES.map((t) => t.id)).toEqual([
      "maison-blanche-idr",
      "black-monday-idr",
      "black-monday-cra",
      "american-housewife-idr",
      "american-housewife-cra",
      "american-housewife-cra-leading",
      "american-housewife-cra-600",
      "ghosted-cra",
      "ghosted-cra-leading",
      "pearl-harbor-cra",
      "pearl-harbor-cra-leading",
      "ted-lasso-cra",
      "prestige-preparer",
      "alien-romulus-idr",
    ]);
    const byId = Object.fromEntries(SERIES.map((t) => [t.id, t]));
    // Le départ à 600 s, les deux parcours de 20 sauts, le tour des pistes, la préparation seule.
    expect(byId["american-housewife-cra-600"]).toMatchObject({ cut: "cra", startAt: 600, tours: [10] });
    for (const id of ["ghosted-cra", "ghosted-cra-leading", "pearl-harbor-cra", "pearl-harbor-cra-leading"]) expect(byId[id].tours).toEqual([20, 20]);
    expect(byId["ted-lasso-cra"].audioTour).toBe(true);
    expect(byId["prestige-preparer"].prepareOnly).toEqual(["idr", "cra"]);
    expect(byId["maison-blanche-idr"]).toMatchObject({ startAt: 0, tours: [10], audioTour: false });
    // Les titres sont ceux que la page propose déjà, avec leurs identifiants.
    for (const t of SERIES) expect(PRESETS.some((p) => p.id === t.itemId && p.title === t.title)).toBe(true);
  });

  it("estime une demi-heure, et la barre avance sans dépasser l'essai en cours", () => {
    const total = seriesEstimateS(SERIES);
    expect(total).toBeGreaterThan(25 * 60);
    expect(total).toBeLessThan(40 * 60);
    expect(seriesProgress(SERIES, 0, 0)).toBe(0);
    const firstShare = seriesProgress(SERIES, 1, 0);
    // Un essai qui dure plus que prévu reste sous sa part : la barre n'annonce jamais l'essai suivant.
    expect(seriesProgress(SERIES, 0, 10_000)).toBeLessThan(firstShare);
    expect(seriesProgress(SERIES, SERIES.length, 0)).toBe(1);
  });
});

type Call = string;

/** Un pilote factice : chaque geste est noté ; `script` décide de ce que chaque essai rend. */
function fakeDriver(script: {
  prepare?: (t: Trial, cut: Cut) => PreparedVerdict | null | Error;
  start?: (t: Trial) => StartResult | Error;
  stopAfter?: string;
} = {}) {
  const calls: Call[] = [];
  const sent: { trial: string; rank: number; result: TrialResult }[] = [];
  let stopped = false;
  const ok: PreparedVerdict = { ok: true, version: "1c1-0123456789ab", audioTrack: 1, segments: 10, longestS: 12 };
  const driver: SeriesDriver = {
    stopped: () => stopped,
    begin: (t, rank) => calls.push(`begin ${rank} ${t.id}`),
    prepare: async (t, cut) => {
      calls.push(`prepare ${t.id} ${cut}`);
      const r = script.prepare ? script.prepare(t, cut) : ok;
      if (r instanceof Error) throw r;
      return r;
    },
    start: async (t, rank) => {
      calls.push(`start ${rank} ${t.id}`);
      const r = script.start ? script.start(t) : { image: true as const };
      if (r instanceof Error) throw r;
      return r;
    },
    play: async (ms) => void calls.push(`play ${ms}`),
    tour: async (count, index) => {
      calls.push(`tour ${index} ${count}`);
      if (script.stopAfter === `tour ${index}`) stopped = true;
    },
    audioTour: async () => void calls.push("audio"),
    close: (t, rank, outcome: TrialOutcome) => {
      calls.push(`close ${rank} ${outcome.status}`);
      return resultOf(t, rank, outcome);
    },
    send: async (t, rank, result) => {
      calls.push(`send ${rank}`);
      sent.push({ trial: t.id, rank, result });
    },
  };
  return { driver, calls, sent };
}

describe("l'enchaînement", () => {
  it("déroule chaque essai dans l'ordre, et envoie chacun avant de passer au suivant", async () => {
    const { driver, calls, sent } = fakeDriver();
    const { results, stopped } = await runSeries(SERIES, driver);
    expect(stopped).toBe(false);
    expect(results.map((r) => r.trial)).toEqual(SERIES.map((t) => t.id));
    expect(sent.map((s) => s.rank)).toEqual(SERIES.map((_, i) => i + 1));
    // Le détail d'un essai : préparer, lire, 10 s, le parcours, fermer, envoyer — puis seulement le suivant.
    expect(calls.slice(0, 8)).toEqual(["begin 1 maison-blanche-idr", "prepare maison-blanche-idr idr", "start 1 maison-blanche-idr", "play 10000", "tour 0 10", "close 1 ok", "send 1", "begin 2 black-monday-idr"]);
    // Deux parcours de 20 puis le tour des pistes sur Ghosted ; Le Prestige préparé deux fois et jamais lu.
    const ghosted = calls.slice(calls.indexOf("begin 8 ghosted-cra"), calls.indexOf("begin 9 ghosted-cra-leading"));
    expect(ghosted).toEqual(["begin 8 ghosted-cra", "prepare ghosted-cra cra", "start 8 ghosted-cra", "play 10000", "tour 0 20", "tour 1 20", "audio", "close 8 ok", "send 8"]);
    const prestige = calls.slice(calls.indexOf("begin 13 prestige-preparer"), calls.indexOf("begin 14 alien-romulus-idr"));
    expect(prestige).toEqual(["begin 13 prestige-preparer", "prepare prestige-preparer idr", "prepare prestige-preparer cra", "close 13 préparé", "send 13"]);
    expect(results[12].verdicts).toEqual(["idr : servi (10 segments, le plus long 12 s)", "cra : servi (10 segments, le plus long 12 s)"]);
  });

  it("un essai qui échoue ne bloque jamais la série — refus, pas d'image, exception", async () => {
    const { driver, calls, sent } = fakeDriver({
      prepare: (t, cut) =>
        t.id === "black-monday-cra" ? new Error("réseau") : t.id === "pearl-harbor-cra" ? { ok: false, reason: "segment-trop-long", detail: "136 s", audioTrack: null } : { ok: true, version: "1-0123456789ab", audioTrack: 1, segments: 3, longestS: 9 },
      start: (t) => (t.id === "maison-blanche-idr" ? { image: false, reason: "sans image après 20 s" } : t.id === "ted-lasso-cra" ? new Error("boum") : { image: true }),
    });
    const { results } = await runSeries(SERIES, driver);
    expect(results).toHaveLength(SERIES.length);
    expect(sent).toHaveLength(SERIES.length);
    const byId = Object.fromEntries(results.map((r) => [r.trial, r]));
    expect(byId["maison-blanche-idr"]).toMatchObject({ status: "échec", reason: "sans image après 20 s" });
    expect(byId["black-monday-cra"]).toMatchObject({ status: "échec", reason: "exception Error: réseau" });
    expect(byId["pearl-harbor-cra"]).toMatchObject({ status: "refusé", reason: "segment-trop-long (136 s)" });
    expect(byId["ted-lasso-cra"]).toMatchObject({ status: "échec", reason: "exception Error: boum" });
    expect(byId["alien-romulus-idr"].status).toBe("ok");
    // Sans image, ni lecture de 10 s ni parcours : on passe à la suite.
    expect(calls.slice(0, 5)).toEqual(["begin 1 maison-blanche-idr", "prepare maison-blanche-idr idr", "start 1 maison-blanche-idr", "close 1 échec", "send 1"]);
    // Un refus du serveur ne lance pas de lecture.
    expect(calls).not.toContain("start 10 pearl-harbor-cra");
  });

  it("un envoi qui échoue ne change rien à la série", async () => {
    const { driver } = fakeDriver();
    let n = 0;
    driver.send = async () => {
      n += 1;
      throw new Error("hors ligne");
    };
    const { results } = await runSeries(SERIES, driver);
    expect(results).toHaveLength(SERIES.length);
    expect(n).toBe(SERIES.length);
  });

  it("« Arrêter » finit l'essai en cours — sa ligne part — et rien après", async () => {
    const { driver, calls, sent } = fakeDriver({ stopAfter: "tour 0" });
    const { results, stopped } = await runSeries(SERIES, driver);
    expect(stopped).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("arrêté");
    expect(sent.map((s) => s.rank)).toEqual([1]);
    expect(calls.at(-1)).toBe("send 1");
  });
});

describe("les lignes", () => {
  it("résume un essai : première image, médiane des sauts, gels, erreurs, pistes", () => {
    const t = SERIES.find((x) => x.id === "ted-lasso-cra")!;
    const r = resultOf(t, 12, { status: "ok" }, {
      firstFrameMs: 1840,
      seeks: [{ ok: true, advanceMs: 900 }, { ok: true, advanceMs: 1500 }, { ok: true, advanceMs: 1100 }, { ok: false }],
      freezes: [{ at: 600.5, ms: 2400, afterSeek: true, until: "image" }],
      errors: ["code=3 decode"],
      waits: 2,
      quality: { total: 5000, dropped: 3, corrupted: 0 },
      audioSwitches: [{ ms: 400, waited: false, errors: 0, freezes: 0 }, { ms: 500, waited: true }, { waited: false }],
    });
    expect(r).toMatchObject({ seeks: 4, missed: 1, seekMedianMs: 1100, freezes: 1, freezeMs: 2400, errors: 1, firstError: "code=3 decode", waits: 2, frames: 5000, dropped: 3, audioSwitches: 3, audioTrouble: 2 });
    expect(formatResult(r)).toBe("12. Ted Lasso S02E01 · cra — image 1840 ms · sauts 1100 ms (méd.), 1 manqué · gels 1 (2.4 s) · erreurs 1 · pistes 1/3 nettes");
  });

  it("la ligne récapitulative porte chaque essai et les deux réponses", () => {
    const results = SERIES.slice(0, 2).map((t, i) => resultOf(t, i + 1, { status: "ok" }));
    const body = summaryBody("abc123def456", SERIES.length, results, { damaged: "oui", damagedTitle: "  Ghosted  ", audioClean: "pas-entendu" }, { elapsedS: 1834.4, stopped: false });
    expect(body.auto).toEqual({ serie: "abc123def456", summary: true, of: 14, done: 2, elapsedS: 1834, stopped: false });
    expect(body.trials.map((r) => r.trial)).toEqual(["maison-blanche-idr", "black-monday-idr"]);
    expect(body.answers).toEqual({ damaged: "oui", damagedTitle: "Ghosted", audioClean: "pas-entendu" });
    // « Non » : le titre tapé avant de changer d'avis ne part pas.
    expect(summaryBody("abc123def456", 14, [], { damaged: "non", damagedTitle: "x", audioClean: null }, { elapsedS: 1, stopped: true }).answers).toEqual({ damaged: "non", damagedTitle: undefined, audioClean: null });
  });

  it("les compteurs de décodage : la différence, ou la fin seule s'ils ont été remis à zéro", () => {
    expect(qualityDelta({ total: 100, dropped: 2, corrupted: 0 }, { total: 400, dropped: 5, corrupted: 1 })).toEqual({ total: 300, dropped: 3, corrupted: 1 });
    expect(qualityDelta({ total: 900, dropped: 9, corrupted: 0 }, { total: 300, dropped: 1, corrupted: 0 })).toEqual({ total: 300, dropped: 1, corrupted: 0 });
    expect(qualityDelta(undefined, { total: 3, dropped: 0, corrupted: 0 })).toEqual({ total: 3, dropped: 0, corrupted: 0 });
    expect(qualityDelta({ total: 1, dropped: 0, corrupted: 0 }, undefined)).toBeUndefined();
  });
});

describe("la détection des gels, sur une horloge factice", () => {
  /** Une lecture à vitesse 1 : une image toutes les 40 ms (25 i/s), sauf entre `frozenFrom` et `frozenTo` (ms). */
  function play(watch: FreezeWatch, fromMs: number, toMs: number, startT: number, frozen?: [number, number]) {
    const found = [];
    for (let now = fromMs; now <= toMs; now += 40) {
      const t = startT + (now - fromMs) / 1000;
      const isFrozen = frozen && now >= frozen[0] && now < frozen[1];
      if (!isFrozen) watch.frame(now, t);
      // La page vérifie toutes les 2 s.
      if ((now - fromMs) % 2000 === 0) {
        const f = watch.check(now, t);
        if (f) found.push(f);
      }
    }
    return found;
  }

  it("une lecture fluide ne donne aucun gel", () => {
    const watch = new FreezeWatch();
    expect(play(watch, 0, 30_000, 0)).toEqual([]);
    expect(watch.freezes).toEqual([]);
    expect(watch.presented).toBeGreaterThan(700);
  });

  it("la position qui avance sans image pendant 3 s est un gel : sa position, sa durée", () => {
    const watch = new FreezeWatch();
    play(watch, 0, 20_000, 0, [10_000, 13_000]);
    expect(watch.freezes).toHaveLength(1);
    const [f] = watch.freezes;
    // La dernière image avant le gel est à ~10 s ; il dure ~3 s, fini par une image.
    expect(f.at).toBeCloseTo(10, 0);
    expect(f.afterSeek).toBe(false);
    expect(f.until).toBe("image");
    expect(f.ms).toBeGreaterThanOrEqual(2900);
    expect(f.ms).toBeLessThanOrEqual(3100);
  });

  it("une image qui manque moins d'une seconde n'est pas un gel", () => {
    const watch = new FreezeWatch();
    play(watch, 0, 10_000, 0, [3_900, 4_700]);
    expect(watch.freezes).toEqual([]);
  });

  it("après un saut, la position qui avance sans image est un gel « après un saut » — l'attente du saut ne compte pas", () => {
    const watch = new FreezeWatch();
    play(watch, 0, 5_000, 0);
    // Saut à 600 s : `seeking` puis `seeked` 800 ms plus tard ; la lecture reprend, le son avance, l'image non.
    watch.rebase(5_100, 600);
    watch.rebase(5_900, 599.5);
    expect(watch.check(6_000, 599.6)).toBeNull();
    const f = watch.check(8_000, 601.6);
    expect(f).toMatchObject({ at: 599.5, afterSeek: true, ms: null });
    // Commencé à la reprise (2,1 s d'avance au constat de 8 000 ms : 5 900 ms, l'instant de `seeked`), fermé par
    // le saut suivant du parcours.
    watch.rebase(10_000, 1200);
    expect(watch.freezes[0].until).toBe("saut");
    expect(watch.freezes[0].ms).toBe(4_100);
    expect(watch.frozenMs).toBe(4_100);
  });

  it("avant la première image, rien : c'est l'attente de la première image qui juge", () => {
    const watch = new FreezeWatch();
    watch.rebase(0, 600);
    expect(watch.check(5_000, 605)).toBeNull();
    expect(watch.freezes).toEqual([]);
  });

  it("vidéo hors de la vue ou page cachée : le jugement repart de la position, sans compter l'absence d'images", () => {
    const watch = new FreezeWatch();
    play(watch, 0, 2_000, 0);
    // L'administrateur fait défiler : plus d'images, la page rebase toutes les 2 s au lieu de vérifier.
    watch.rebase(4_000, 4, false);
    watch.rebase(6_000, 6, false);
    expect(watch.freezes).toEqual([]);
    // Un gel déjà constaté est fermé à ce moment-là, marqué « masqué » : sa durée est un minimum.
    expect(watch.check(8_000, 8)).not.toBeNull();
    watch.rebase(9_000, 9, false);
    expect(watch.freezes[0]).toMatchObject({ until: "masqué", afterSeek: false, ms: 3_000 });
  });

  it("un gel encore ouvert à la fin de l'essai est fermé là", () => {
    const watch = new FreezeWatch();
    play(watch, 0, 2_000, 0);
    expect(watch.check(4_000, 4)).not.toBeNull();
    watch.end(5_000);
    expect(watch.freezes[0]).toMatchObject({ until: "fin", ms: 3_000 });
  });
});

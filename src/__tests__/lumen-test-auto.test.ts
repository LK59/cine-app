import { describe, it, expect } from "vitest";
import {
  DEFAULT_TARGET_S,
  EARLY_DELAY_MS,
  FreezeWatch,
  LEVER_SERIES,
  SAFARI_WAIT_SERIES,
  PRESETS,
  QUICK_SERIES,
  SERIES,
  comparisonRows,
  formatChrono,
  formatResult,
  modeTag,
  planOf,
  qualityDelta,
  resultOf,
  runSeries,
  seekPositions,
  seriesEstimateS,
  seriesProgress,
  summaryBody,
  trialTag,
  type Cut,
  type PreparedVerdict,
  type SeriesDriver,
  type StartResult,
  type Trial,
  type TrialOutcome,
  type TrialResult,
} from "@/components/lumenTest/autoSeries";

// « Tout enchaîner » et « Comparatif rapide » de la page de banc `/lumen-test` (étapes 3b et 3c de
// docs/remux-serveur/, DECISIONS §157, §158) : la partie sans navigateur. Chaque titre est joué par Lumen serveur
// puis par le lecteur actuel, tous les essais serveur d'abord (WebKit refuse un HLS natif après une MediaSource),
// avec les mêmes positions de saut ; un essai qui échoue n'arrête jamais la série ; chaque essai est envoyé avant
// le suivant ; « Arrêter » finit l'essai en cours et rien après ; un gel se voit sur une horloge factice. Le
// branchement sur la vraie page est éprouvé par `lumen-test-page.test.tsx`.

describe("le plan des séries", () => {
  it.each([
    ["complète", SERIES],
    ["courte", QUICK_SERIES],
  ] as const)("%s : tous les essais serveur d'abord, puis le lecteur actuel sur chaque titre, avec les mêmes parcours", (pass, plan) => {
    expect(planOf(pass)).toBe(plan);
    const firstCurrent = plan.findIndex((t) => t.player === "actuel");
    expect(firstCurrent).toBeGreaterThan(0);
    expect(plan.slice(firstCurrent).every((t) => t.player === "actuel")).toBe(true);
    const server = plan.filter((t) => t.player === "serveur" && !t.prepareOnly && t.targetS === DEFAULT_TARGET_S && !t.modes);
    const current = plan.filter((t) => t.player === "actuel");
    expect(current.map((t) => [t.key, t.tours])).toEqual(server.map((t) => [t.key, t.tours]));
    expect(new Set(plan.map((t) => t.id)).size).toBe(plan.length);
    for (const t of plan) expect(PRESETS.some((p) => p.id === t.itemId && p.title === t.title && p.key === t.key)).toBe(true);
    // Le lecteur actuel n'a pas de tour des pistes (`audioTracks` est HLS) ; la découpe du serveur est la règle.
    expect(current.every((t) => !t.audioTour)).toBe(true);
    expect(plan.every((t) => t.cut === "cra")).toBe(true);
  });

  it("la série complète : les titres de l'étape 3b, et la cible de 2 s sur les titres aux clés rapprochées", () => {
    expect(SERIES.map((t) => t.id)).toEqual([
      "maison-blanche-serveur",
      "maison-blanche-serveur-t2",
      "black-monday-serveur",
      "black-monday-serveur-t2",
      "notting-hill-serveur",
      "notting-hill-serveur-t2",
      "american-housewife-serveur",
      "ghosted-serveur",
      "pearl-harbor-serveur",
      "ted-lasso-serveur",
      "alien-romulus-serveur",
      "prestige-preparer",
      "maison-blanche-actuel",
      "black-monday-actuel",
      "notting-hill-actuel",
      "american-housewife-actuel",
      "ghosted-actuel",
      "pearl-harbor-actuel",
      "ted-lasso-actuel",
      "alien-romulus-actuel",
    ]);
    const byId = Object.fromEntries(SERIES.map((t) => [t.id, t]));
    expect(byId["ghosted-serveur"].tours).toEqual([20]);
    expect(byId["ted-lasso-serveur"].audioTour).toBe(true);
    expect(byId["prestige-preparer"].prepareOnly).toEqual(["cra"]);
    expect(byId["black-monday-serveur-t2"]).toMatchObject({ targetS: 2, tours: [10], player: "serveur" });
  });

  it("le comparatif rapide : un H.264, un HEVC à IDR, un HEVC à GOP ouvert, un DV 4K Atmos, 10 sauts ; puis les leviers a et b sur Ghosted et Ted Lasso", () => {
    expect(QUICK_SERIES.map((t) => t.id)).toEqual([
      "maison-blanche-serveur",
      "black-monday-serveur",
      "ghosted-serveur",
      "ted-lasso-serveur",
      "ghosted-serveur-mux",
      "ted-lasso-serveur-mux",
      "ghosted-serveur-prep",
      "ted-lasso-serveur-prep",
      "maison-blanche-actuel",
      "black-monday-actuel",
      "ghosted-actuel",
      "ted-lasso-actuel",
    ]);
    const base = QUICK_SERIES.filter((t) => !t.modes);
    expect(base.every((t) => t.tours.length === 1 && t.tours[0] === 10 && !t.audioTour)).toBe(true);
    expect(QUICK_SERIES.filter((t) => t.modes?.mux).map((t) => t.tours)).toEqual([[5], [5]]);
    expect(QUICK_SERIES.filter((t) => t.modes?.early).map((t) => t.modes?.early)).toEqual(["serveur", "serveur"]);
    // Les leviers sont des essais serveur : le lecteur actuel n'en a pas.
    expect(QUICK_SERIES.filter((t) => t.modes).every((t) => t.player === "serveur")).toBe(true);
  });

  it("l'attente de Safari : débit au quart et segments de 2 s, seuls puis ensemble, encadrés par des témoins, sur deux titres", () => {
    expect(planOf("attente")).toBe(SAFARI_WAIT_SERIES);
    expect(planOf("attente", "actuel")).toBe(SAFARI_WAIT_SERIES);
    expect(SAFARI_WAIT_SERIES.every((t) => t.player === "serveur" && t.tours.join() === "5")).toBe(true);
    expect(new Set(SAFARI_WAIT_SERIES.map((t) => t.id)).size).toBe(SAFARI_WAIT_SERIES.length);
    for (const key of ["ghosted", "ted-lasso"]) {
      const kinds = SAFARI_WAIT_SERIES.filter((t) => t.key === key).map((t) => `${t.targetS}${t.modes?.bandwidth === "bas" ? "-bas" : ""}`);
      expect(new Set(kinds)).toEqual(new Set(["4", "4-bas", "2", "2-bas"]));
      // Le premier et le dernier essai d'un titre sont le même : la dérive du réseau se lit entre eux.
      expect(kinds[0]).toBe(kinds[kinds.length - 1]);
    }
    expect(modeTag({ bandwidth: "bas" })).toBe("bwbas");
    for (const t of SAFARI_WAIT_SERIES) expect(t.id).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(seriesEstimateS(SAFARI_WAIT_SERIES)).toBeLessThan(15 * 60);
  });

  it("les leviers de démarrage : chaque levier à côté d'un témoin du même titre ; le départ à 600 s par les trois chemins", () => {
    expect(planOf("leviers")).toBe(LEVER_SERIES);
    expect(LEVER_SERIES.every((t) => t.player === "serveur")).toBe(true);
    expect(new Set(LEVER_SERIES.map((t) => t.id)).size).toBe(LEVER_SERIES.length);
    const starts = LEVER_SERIES.filter((t) => t.modes?.startMode);
    expect(starts.map((t) => `${t.key}:${t.modes!.startMode}:${t.startAt}`).sort()).toEqual(
      ["black-monday", "ghosted"].flatMap((k) => ["ext-x-start", "fragment", "saut"].map((m) => `${k}:${m}:600`)).sort()
    );
    for (const t of LEVER_SERIES.filter((x) => x.modes && !x.modes.startMode && x.key !== "maison-blanche")) {
      expect(LEVER_SERIES.some((w) => w.key === t.key && !w.modes), t.id).toBe(true);
    }
    expect(modeTag({ startMode: "ext-x-start" })).toBe("depart-xstart");
    expect(modeTag({ early: "élément" })).toBe("fiche");
    expect(modeTag({ bandwidth: "moyen" })).toBe("bw");
    // Les noms passent la règle de la ligne (`trialName` : 40 caractères au plus).
    for (const t of [...SERIES, ...QUICK_SERIES, ...LEVER_SERIES]) expect(t.id).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it("l'ordre « lecteur actuel d'abord » : les mêmes essais, le lecteur actuel en tête, un rechargement avant le premier essai serveur", () => {
    for (const pass of ["complète", "courte"] as const) {
      const plan = planOf(pass, "actuel");
      const straight = planOf(pass);
      expect(plan.map((t) => t.id).sort()).toEqual(straight.map((t) => t.id).sort());
      const firstServer = plan.findIndex((t) => t.player === "serveur");
      expect(plan.slice(0, firstServer).every((t) => t.player === "actuel")).toBe(true);
      expect(plan.slice(firstServer).every((t) => t.player === "serveur")).toBe(true);
      expect(plan.filter((t) => t.reloadBefore).map((t) => t.id)).toEqual([plan[firstServer].id]);
      expect(straight.some((t) => t.reloadBefore)).toBe(false);
    }
    // Les leviers n'ont qu'un lecteur : un seul ordre.
    expect(planOf("leviers", "actuel")).toBe(LEVER_SERIES);
  });

  it("estime ~30 minutes pour la série complète, 12 à 15 pour la rapide ; la barre avance sans dépasser l'essai en cours", () => {
    const total = seriesEstimateS(SERIES);
    expect(total).toBeGreaterThan(25 * 60);
    expect(total).toBeLessThan(35 * 60);
    expect(seriesEstimateS(QUICK_SERIES)).toBeGreaterThan(9 * 60);
    // La consigne de l'étape 3e : le comparatif rapide, leviers compris, en moins de 15 minutes.
    expect(seriesEstimateS(QUICK_SERIES)).toBeLessThan(15 * 60);
    expect(seriesEstimateS(LEVER_SERIES)).toBeLessThan(13 * 60);
    expect(EARLY_DELAY_MS).toBe(5000);
    expect(seriesProgress(SERIES, 0, 0)).toBe(0);
    const firstShare = seriesProgress(SERIES, 1, 0);
    // Un essai qui dure plus que prévu reste sous sa part : la barre n'annonce jamais l'essai suivant.
    expect(seriesProgress(SERIES, 0, 10_000)).toBeLessThan(firstShare);
    expect(seriesProgress(SERIES, SERIES.length, 0)).toBe(1);
  });
});

describe("les positions des sauts", () => {
  it("les mêmes pour les deux lecteurs d'un titre : même graine, même titre, même parcours, même durée", () => {
    const a = seekPositions(123456, "ghosted", 0, 20, 7014.3);
    expect(seekPositions(123456, "ghosted", 0, 20, 7014.3)).toEqual(a);
    expect(a).toHaveLength(20);
    for (const t of a) {
      expect(t).toBeGreaterThanOrEqual(30);
      expect(t).toBeLessThanOrEqual(7014.3 - 60);
      expect(Math.round(t * 10) / 10).toBe(t);
    }
    // Un autre titre, un autre parcours ou une autre graine : d'autres positions.
    expect(seekPositions(123456, "pearl-harbor", 0, 20, 7014.3)).not.toEqual(a);
    expect(seekPositions(123456, "ghosted", 1, 20, 7014.3)).not.toEqual(a);
    expect(seekPositions(654321, "ghosted", 0, 20, 7014.3)).not.toEqual(a);
    // Un film court reste dans ses bornes.
    for (const t of seekPositions(1, "x", 0, 50, 100)) expect(t).toBeLessThanOrEqual(95);
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
  const ok: PreparedVerdict = { ok: true, version: "2-0123456789ab", audioTrack: 1, segments: 10, longestS: 12, durationS: 3000 };
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
    expect(calls.slice(0, 8)).toEqual(["begin 1 maison-blanche-serveur", "prepare maison-blanche-serveur cra", "start 1 maison-blanche-serveur", "play 10000", "tour 0 10", "close 1 ok", "send 1", "begin 2 maison-blanche-serveur-t2"]);
    // Le tour des pistes sur Ted Lasso côté serveur, jamais côté lecteur actuel ; Le Prestige préparé et jamais lu.
    const ted = calls.slice(calls.indexOf("begin 10 ted-lasso-serveur"), calls.indexOf("begin 11 alien-romulus-serveur"));
    expect(ted).toEqual(["begin 10 ted-lasso-serveur", "prepare ted-lasso-serveur cra", "start 10 ted-lasso-serveur", "play 10000", "tour 0 10", "audio", "close 10 ok", "send 10"]);
    expect(calls.slice(calls.indexOf("begin 19 ted-lasso-actuel"), calls.indexOf("begin 20 alien-romulus-actuel"))).not.toContain("audio");
    const prestige = calls.slice(calls.indexOf("begin 12 prestige-preparer"), calls.indexOf("begin 13 maison-blanche-actuel"));
    expect(prestige).toEqual(["begin 12 prestige-preparer", "prepare prestige-preparer cra", "close 12 préparé", "send 12"]);
    expect(results[11].verdicts).toEqual(["cra : servi (10 segments, le plus long 12 s)"]);
    const ghostedCurrent = calls.slice(calls.indexOf("begin 17 ghosted-actuel"), calls.indexOf("begin 18 pearl-harbor-actuel"));
    expect(ghostedCurrent).toEqual(["begin 17 ghosted-actuel", "prepare ghosted-actuel cra", "start 17 ghosted-actuel", "play 10000", "tour 0 20", "close 17 ok", "send 17"]);
  });

  it("un essai qui échoue ne bloque jamais la série — refus, pas d'image, exception", async () => {
    const { driver, calls, sent } = fakeDriver({
      prepare: (t) =>
        t.id === "black-monday-serveur" ? new Error("réseau") : t.id === "pearl-harbor-serveur" ? { ok: false, reason: "son-codec", detail: "A_DTS", audioTrack: null } : { ok: true, version: "2-0123456789ab", audioTrack: 1, segments: 3, longestS: 9 },
      start: (t) => (t.id === "maison-blanche-serveur" ? { image: false, reason: "sans image après 20 s" } : t.id === "ted-lasso-actuel" ? new Error("boum") : { image: true }),
    });
    const { results } = await runSeries(SERIES, driver);
    expect(results).toHaveLength(SERIES.length);
    expect(sent).toHaveLength(SERIES.length);
    const byId = Object.fromEntries(results.map((r) => [r.trial, r]));
    expect(byId["maison-blanche-serveur"]).toMatchObject({ status: "échec", reason: "sans image après 20 s" });
    expect(byId["black-monday-serveur"]).toMatchObject({ status: "échec", reason: "exception Error: réseau" });
    expect(byId["pearl-harbor-serveur"]).toMatchObject({ status: "refusé", reason: "son-codec (A_DTS)" });
    expect(byId["ted-lasso-actuel"]).toMatchObject({ status: "échec", reason: "exception Error: boum", player: "actuel" });
    expect(byId["alien-romulus-actuel"].status).toBe("ok");
    // Sans image, ni lecture de 10 s ni parcours : on passe à la suite.
    expect(calls.slice(0, 5)).toEqual(["begin 1 maison-blanche-serveur", "prepare maison-blanche-serveur cra", "start 1 maison-blanche-serveur", "close 1 échec", "send 1"]);
    // Un refus du serveur ne lance pas de lecture serveur ; le lecteur actuel joue quand même le titre.
    expect(calls).not.toContain("start 9 pearl-harbor-serveur");
    expect(calls).toContain("start 18 pearl-harbor-actuel");
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

  it("l'ordre « lecteur actuel d'abord » : la série s'arrête pour recharger avant le premier essai serveur, puis reprend là", async () => {
    const plan = planOf("courte", "actuel");
    const firstServer = plan.findIndex((t) => t.reloadBefore);
    const reloads: number[] = [];
    const before = fakeDriver();
    before.driver.reload = async (index) => void reloads.push(index);
    const first = await runSeries(plan, before.driver);
    expect(reloads).toEqual([firstServer]);
    expect(first.results.map((r) => r.player)).toEqual(plan.slice(0, firstServer).map(() => "actuel"));
    expect(before.calls).not.toContain(`begin ${firstServer + 1} ${plan[firstServer].id}`);
    // Après le rechargement : la série reprend au même rang, sans recharger de nouveau.
    const after = fakeDriver();
    after.driver.reload = async (index) => void reloads.push(index);
    const second = await runSeries(plan, after.driver, undefined, { from: firstServer });
    expect(reloads).toEqual([firstServer]);
    expect(second.results.map((r) => r.trial)).toEqual(plan.slice(firstServer).map((t) => t.id));
    expect(second.results[0].rank).toBe(firstServer + 1);
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
  it("résume un essai : première image, sauts (seeked et reprise, médiane et p90), gels, erreurs, pistes", () => {
    const t = SERIES.find((x) => x.id === "ted-lasso-serveur")!;
    const r = resultOf(t, 10, { status: "ok" }, {
      firstFrameMs: 1840,
      seeks: [{ ok: true, seekedMs: 500, advanceMs: 900 }, { ok: true, seekedMs: 700, advanceMs: 1500 }, { ok: true, seekedMs: 600, advanceMs: 1100 }, { ok: false }],
      freezes: [{ at: 600.5, ms: 2400, afterSeek: true, until: "image" }],
      errors: ["code=3 decode"],
      waits: 2,
      quality: { total: 5000, dropped: 3, corrupted: 0 },
      audioSwitches: [{ ms: 400, waited: false, errors: 0, freezes: 0 }, { ms: 500, waited: true }, { waited: false }],
    });
    expect(r).toMatchObject({ key: "ted-lasso", player: "serveur", cut: "cra", targetS: 4, seeks: 4, missed: 1, seekMedianMs: 1100, advanceP90Ms: 1500, seekedMedianMs: 600, seekedP90Ms: 700, freezes: 1, freezeMs: 2400, errors: 1, firstError: "code=3 decode", waits: 2, frames: 5000, dropped: 3, audioSwitches: 3, audioTrouble: 2 });
    expect(formatResult(r)).toBe("10. Ted Lasso S02E01 · serveur — image 1840 ms · sauts : image 600/700 ms, reprise 1100/1500 ms (méd./p90), 1 manqué · gels 1 (2.4 s) · erreurs 1 · pistes 1/3 nettes");
    const current = resultOf(SERIES.find((x) => x.id === "ted-lasso-actuel")!, 19, { status: "ok" });
    expect(current).toMatchObject({ player: "actuel", key: "ted-lasso" });
    expect(current).not.toHaveProperty("cut");
    const short = resultOf(SERIES.find((x) => x.id === "black-monday-serveur-t2")!, 4, { status: "refusé", reason: "x" });
    expect(formatResult(short)).toBe("4. Black Monday S02E10 · serveur 2 s — refusé : x");
  });

  it("le tableau côte à côte : une ligne par titre (et par cible serveur autre que 4 s), les deux lecteurs en face", () => {
    const at = (id: string) => SERIES.find((x) => x.id === id)!;
    const measured = (advance: number[], seeked: number[], firstFrameMs: number) => ({
      firstFrameMs,
      seeks: advance.map((a, i) => ({ ok: true, advanceMs: a, seekedMs: seeked[i] })),
      freezes: [],
      errors: [],
      waits: 0,
      audioSwitches: [],
    });
    const results = [
      resultOf(at("black-monday-serveur"), 3, { status: "ok" }, measured([1500, 1400, 1600], [600, 700, 650], 900)),
      resultOf(at("black-monday-serveur-t2"), 4, { status: "ok" }, measured([1100, 1000, 1200], [500, 450, 520], 800)),
      resultOf(at("prestige-preparer"), 12, { status: "préparé", prepared: [{ cut: "cra", verdict: null }] }),
      resultOf(at("black-monday-actuel"), 14, { status: "ok" }, measured([500, 400, 450], [300, 250, 280], 1300)),
    ];
    const rows = comparisonRows(results);
    expect(rows.map((r) => [r.key, r.targetS, !!r.serveur, !!r.actuel])).toEqual([
      ["black-monday", 4, true, true],
      ["black-monday", 2, true, false],
    ]);
    expect(rows[0].serveur).toMatchObject({ firstFrameMs: 900, seekedMedianMs: 650, seekedP90Ms: 700, advanceMedianMs: 1500, advanceP90Ms: 1600 });
    expect(rows[0].actuel).toMatchObject({ firstFrameMs: 1300, seekedMedianMs: 280, advanceMedianMs: 450, advanceP90Ms: 500 });
  });

  it("chaque ligne porte le lecteur, la passe et la graine ; la récapitulative, le tableau et les deux réponses", () => {
    expect(trialTag("abc123def456", QUICK_SERIES[8], 9, QUICK_SERIES.length, { pass: "courte", seed: 42 })).toEqual({
      serie: "abc123def456",
      trial: "maison-blanche-actuel",
      rank: 9,
      of: 12,
      player: "actuel",
      pass: "courte",
      seed: 42,
    });
    expect(trialTag("abc123def456", QUICK_SERIES[4], 5, 12, { pass: "courte", seed: 42, order: "actuel" })).toMatchObject({ trial: "ghosted-serveur-mux", mode: "mux", order: "actuel" });
    const results = SERIES.slice(0, 2).map((t, i) => resultOf(t, i + 1, { status: "ok" }));
    const body = summaryBody("abc123def456", SERIES.length, results, { damaged: "oui", damagedTitle: "  Ghosted  ", audioClean: "pas-entendu" }, { elapsedS: 1834.4, stopped: false, pass: "complète", seed: 42 });
    expect(body.auto).toEqual({ serie: "abc123def456", summary: true, of: 20, done: 2, elapsedS: 1834, stopped: false, pass: "complète", seed: 42 });
    expect(body.trials.map((r) => r.trial)).toEqual(["maison-blanche-serveur", "maison-blanche-serveur-t2"]);
    expect(body.comparison.map((r) => r.targetS)).toEqual([4, 2]);
    expect(body.answers).toEqual({ damaged: "oui", damagedTitle: "Ghosted", audioClean: "pas-entendu" });
    // « Non » : le titre tapé avant de changer d'avis ne part pas.
    expect(summaryBody("abc123def456", 9, [], { damaged: "non", damagedTitle: "x", audioClean: null }, { elapsedS: 1, stopped: true, pass: "courte", seed: 1 }).answers).toEqual({ damaged: "non", damagedTitle: undefined, audioClean: null });
  });

  it("la chronologie d'un essai : dans son résultat, sa ligne d'écran et sa ligne du tableau (un levier a sa propre ligne)", () => {
    const at = (id: string) => QUICK_SERIES.find((x) => x.id === id)!;
    const chrono = { aheadAdvanceS: 21.5, aheadSeekedS: 6, firstReqMs: 40, firstVideoReadyMs: 95, seekedToAdvanceMs: 820, videoAdvance: 5, readyMaxMs: 210 };
    const base = { seeks: [], freezes: [], errors: [], waits: 0, audioSwitches: [] };
    const r = resultOf(at("ghosted-serveur-mux"), 5, { status: "ok" }, { ...base, firstFrameMs: 700, chrono, linkMbps: 180 });
    expect(r).toMatchObject({ mode: "mux", chrono, linkMbps: 180 });
    expect(formatChrono(r)).toBe("lien 180 Mb/s · 1re requête +40 ms · segment prêt +95 ms · seeked→reprise 820 ms · avance à seeked 6 s · à la reprise 21.5 s · 5 seg. vidéo demandés · serveur ≤ 210 ms");
    expect(formatResult(r)).toMatch(/^5\. Ghosted · serveur \(mux\) — image 700 ms · gels 0 · erreurs 0 · lien 180/);
    const plain = resultOf(at("ghosted-serveur"), 3, { status: "ok" }, { ...base, firstFrameMs: 1200 });
    const rows = comparisonRows([plain, r]);
    expect(rows.map((x) => [x.key, x.mode ?? null, x.serveur?.firstFrameMs])).toEqual([
      ["ghosted", null, 1200],
      ["ghosted", "mux", 700],
    ]);
    // Un départ en milieu de film : la première image à la position demandée, quand elle diffère de la toute première.
    const start = resultOf(LEVER_SERIES.find((t) => t.id === "ghosted-serveur-depart-saut")!, 6, { status: "ok" }, { ...base, firstFrameMs: 500, targetFrameMs: 1400 });
    expect(start.targetFrameMs).toBe(1400);
    expect(formatResult(start)).toContain("image au départ 1400 ms");
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

describe("la passe « Son converti » (phase 2, DECISIONS §161, §163)", () => {
  it("Lumen serveur seul, chaque codec avec et sans pool en ordre alterné, ~10 minutes, des noms d'essai distincts", async () => {
    const { CONVERT_SERIES, planOf, seriesEstimateS } = await import("@/components/lumenTest/autoSeries");
    expect(planOf("son")).toBe(CONVERT_SERIES);
    expect(planOf("son", "actuel")).toBe(CONVERT_SERIES);
    expect(CONVERT_SERIES.every((t) => t.player === "serveur")).toBe(true);
    expect(CONVERT_SERIES.slice(0, 8).map((t) => `${t.key}:${t.modes?.conv}`)).toEqual([
      "prestige:sans-pool",
      "prestige:pool",
      "interstellar:pool",
      "interstellar:sans-pool",
      "braveheart:sans-pool",
      "braveheart:pool",
      "jojo:pool",
      "jojo:sans-pool",
    ]);
    expect(new Set(CONVERT_SERIES.map((t) => t.id)).size).toBe(CONVERT_SERIES.length);
    // La VO TrueHD de *Braveheart* (piste 3), et le tour des pistes entre elle et la VF copiée.
    expect(CONVERT_SERIES.filter((t) => t.key === "braveheart").every((t) => t.audio === 3)).toBe(true);
    expect(CONVERT_SERIES.some((t) => t.key === "braveheart" && t.audioTour)).toBe(true);
    const minutes = seriesEstimateS(CONVERT_SERIES) / 60;
    expect(minutes).toBeGreaterThan(6);
    expect(minutes).toBeLessThan(13);
  });
});

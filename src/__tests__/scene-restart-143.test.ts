import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideSceneRestart, type SceneRestartInput, type SceneRestartScene } from "@/lib/sceneRestart";
import {
  beginSceneRestart,
  endSceneRestart,
  forgetSceneRestart,
  noteLastPlayedAt,
  noteSceneRestartInterrupt,
  noteSceneRestartOutcome,
  noteSceneRestartVerdict,
  sceneRestartLogFields,
  sceneRestartState,
} from "@/lib/sceneRestartSession";

/**
 * « Revenir au début de la scène » (DECISIONS.md §143).
 *
 * Les deux titres de la R&D du 10/11/2026, tels que le service les rendait en `cutsVersion` 1
 * (`xray/app/scenecuts.py` sur les frontières et les zones de parole gardées en base) : début, point d'entrée,
 * verdict de chaque scène — [début, fin, entrée, sûre, raison]. Ils servent de terrain aux règles de Laterna ;
 * les silences (`pauses`, version 2) y sont vides, sauf quand un test en pose.
 */
type Row = [number, number, number, 0 | 1, string];
const TED: Row[] = [[0.0, 86.5, 0.0, 1, "début"], [86.5, 110.944, 86.5, 0, "même-lieu"], [131.923, 237.673, 131.923, 1, "après-saut"], [237.673, 320.0, 237.673, 0, "même-lieu"], [320.0, 348.75, 318.592, 0, "même-lieu"], [348.75, 363.25, 348.064, 0, "même-lieu"], [363.25, 451.5, 363.25, 0, "parole"], [451.5, 631.0, 451.5, 0, "même-lieu"], [631.0, 662.25, 631.0, 0, "même-lieu"], [662.25, 835.25, 662.25, 0, "même-lieu"], [835.25, 910.75, 835.25, 0, "même-lieu"], [910.75, 945.0, 910.75, 0, "même-lieu"], [945.0, 957.0, 945.0, 0, "même-lieu"], [957.0, 995.25, 957.0, 0, "îlot"], [995.25, 1020.75, 995.25, 0, "même-lieu"], [1020.75, 1031.25, 1020.75, 0, "même-lieu"], [1031.25, 1086.25, 1029.28, 0, "même-lieu"], [1086.25, 1174.25, 1086.25, 1, "deux-signaux"], [1174.25, 1319.75, 1171.424, 0, "même-lieu"], [1319.75, 1476.0, 1319.75, 1, "deux-signaux"], [1476.0, 1648.25, 1476.0, 0, "même-lieu"], [1648.25, 1714.5, 1648.25, 0, "même-lieu"], [1714.5, 1869.25, 1714.5, 0, "parole"]];
const FLA: Row[] = [[0.0, 85.0, 0.0, 1, "début"], [85.0, 109.5, 82.656, 1, "deux-signaux"], [109.5, 125.75, 109.5, 1, "deux-signaux"], [125.75, 161.25, 125.75, 0, "parole"], [161.25, 178.5, 161.25, 0, "même-lieu"], [178.5, 202.5, 176.0, 0, "même-lieu"], [202.5, 242.5, 202.5, 0, "parole"], [242.5, 252.5, 241.28, 0, "même-lieu"], [252.5, 415.75, 252.5, 0, "même-lieu"], [415.75, 511.0, 415.75, 1, "deux-signaux"], [511.0, 578.75, 511.0, 0, "même-lieu"], [578.75, 633.25, 576.704, 0, "même-lieu"], [633.25, 732.75, 633.25, 0, "même-lieu"], [732.75, 754.25, 732.75, 0, "parole"], [754.25, 831.0, 754.25, 0, "parole"], [831.0, 859.75, 831.0, 0, "îlot"], [859.75, 924.0, 859.75, 0, "même-lieu"], [924.0, 959.0, 924.0, 0, "parole"], [959.0, 1043.25, 959.0, 0, "parole"], [1043.25, 1065.75, 1043.25, 0, "parole"], [1065.75, 1086.25, 1064.864, 0, "même-lieu"], [1086.25, 1132.5, 1086.25, 0, "parole"], [1132.5, 1142.5, 1131.872, 0, "îlot"], [1142.5, 1191.0, 1142.5, 0, "parole"], [1191.0, 1273.25, 1191.0, 0, "même-lieu"], [1273.25, 1452.75, 1272.224, 0, "même-lieu"], [1452.75, 1547.0, 1452.096, 1, "deux-signaux"], [1547.0, 1571.75, 1545.024, 0, "même-lieu"], [1571.75, 1620.75, 1571.75, 0, "même-lieu"], [1620.75, 1665.25, 1620.75, 0, "parole"], [1665.25, 1697.0, 1663.648, 0, "même-lieu"], [1697.0, 1861.25, 1697.0, 0, "même-lieu"], [1861.25, 1891.168, 1861.25, 0, "même-lieu"]];

const scenesOf = (rows: Row[]): SceneRestartScene[] =>
  rows.map(([start, end, entry, ok, why]) => ({ start, end, entry, cut: { ok: ok === 1, why }, people: [{}], pauses: [] }));

const NOW = Date.parse("2026-11-10T20:00:00Z");
const YESTERDAY = "2026-11-09T21:00:00.000Z";

function input(rows: Row[], position: number, over: Partial<SceneRestartInput> = {}): SceneRestartInput {
  return {
    position,
    now: NOW,
    lastPlayedAt: YESTERDAY,
    payload: { status: "done", complete: true, scenes: scenesOf(rows), speechShare: rows === TED ? 0.5606 : 0.7485 },
    introSkip: rows === TED ? { start: 110.94, end: 131.92 } : null,
    recapSkip: null,
    creditsStart: rows === TED ? 1869.28 : 1861.25,
    ...over,
  };
}

const at = (rows: Row[], position: number, over?: Partial<SceneRestartInput>) => {
  const d = decideSceneRestart(input(rows, position, over));
  return d.offer ? { target: d.target, back: Math.round(d.back * 100) / 100 } : d.reason;
};

describe("la décision, sur Ted Lasso (R&D du 10/11/2026)", () => {
  it("revient au début d'une scène sûre", () => {
    expect(at(TED, 1350)).toEqual({ target: 1319.75, back: 30.25 });
    expect(at(TED, 1170)).toEqual({ target: 1086.25, back: 83.75 });
  });
  it("jamais au début du fichier, ni à la reprise après le générique d'ouverture", () => {
    // 131,923 s suit une plage sautée : un bord de l'analyse, pas un début de scène reconnu.
    expect(at(TED, 200)).toBe("cible-après-saut");
    expect(at(TED.filter((r) => r[0] < 100), 70, { introSkip: null })).toBe("cible-début");
  });
  it("n'enjambe pas un « même lieu », ni rien d'autre de refusé", () => {
    // 1174,25 s coupe un même décor filmé autrement : y remonter dépassait souvent le début de ce qu'on regardait.
    expect(at(TED, 1176)).toBe("coupe-même-lieu");
  });
  it("ne propose rien quand la scène vient de commencer", () => {
    expect(at(TED, 150)).toBe("scène-récente");
    expect(at(TED, 1100)).toBe("scène-récente");
  });
  it("ne remonte pas au-delà d'une minute et demie", () => {
    expect(at(TED, 1200)).toBe("trop-loin");
    expect(at(TED, 1410)).toBe("trop-loin");
    expect(at(TED, 360)).toBe("trop-loin");
    expect(at(TED, 1600)).toBe("trop-loin");
    // L'îlot de 957 s n'est pas une cible : la dernière coupe sûre est loin derrière.
    expect(at(TED, 1000)).toBe("trop-loin");
  });
  it("rien dans l'intro, ni au générique de fin", () => {
    expect(at(TED, 120)).toBe("intro");
    expect(at(TED, 1870)).toBe("générique-de-fin");
  });
});

describe("la décision, sur Le Flambeau (R&D du 10/11/2026)", () => {
  it("revient au début d'une scène sûre", () => {
    expect(at(FLA, 470)).toEqual({ target: 415.75, back: 54.25 });
    // Le point d'entrée : la phrase commencée 0,65 s avant la coupe.
    expect(at(FLA, 1500)).toEqual({ target: 1452.096, back: 47.9 });
    expect(at(FLA, 1540)).toEqual({ target: 1452.096, back: 87.9 });
    expect(at(FLA, 1550)).toBe("trop-loin");
  });
  it("n'enjambe jamais une coupe au milieu d'une phrase", () => {
    expect(at(FLA, 190)).toBe("coupe-parole");
  });
  it("ni un îlot", () => {
    // 1132.5 est un îlot entre deux phrases coupées : rien de sûr à moins d'une minute et demie.
    expect(at(FLA, 1160)).toBe("trop-loin");
    const rows = FLA.map((r) => (r[0] === 1132.5 ? ([r[0], r[1], r[2], 0, "îlot"] as Row) : r));
    rows[21] = [1086.25, 1132.5, 1086.25, 1, "deux-signaux"];
    expect(at(rows, 1160)).toBe("coupe-îlot");
  });
  it("rien au début du fichier, ni juste après une coupe", () => {
    expect(at(FLA, 45)).toBe("début-du-fichier");
    expect(at(FLA, 100)).toBe("scène-récente");
    expect(at(FLA, 140)).toBe("coupe-parole"); // 109,5 s est sûre, mais 125,75 s coupe une phrase
    expect(at(FLA, 600)).toBe("trop-loin");
  });
});

describe("les silences", () => {
  const withPauses = (pauses: [number, number][]) => {
    const base = input(TED, 1350).payload!;
    return { payload: { ...base, scenes: base.scenes.map((s) => (s.start === 1319.75 ? { ...s, pauses } : s)) } };
  };
  const OFFER = { target: 1319.75, back: 30.25 };
  it("un silence de 5 s après le point d'entrée, avant la position : rien", () => {
    expect(at(TED, 1350, withPauses([[1330, 1335]]))).toBe("pause");
    expect(at(TED, 1350, withPauses([[1330, 1334.9]]))).toEqual(OFFER);
  });
  it("mesuré jusqu'à la position seulement", () => {
    expect(at(TED, 1350, withPauses([[1345, 1400]]))).toBe("pause");
    expect(at(TED, 1350, withPauses([[1346, 1400]]))).toEqual(OFFER);
    expect(at(TED, 1350, withPauses([[1351, 1400]]))).toEqual(OFFER);
  });
  it("un silence commencé au point d'entrée ne compte pas (une ouverture sans un mot)", () => {
    expect(at(TED, 1350, withPauses([[1319.75, 1340]]))).toEqual(OFFER);
  });
  it("sans silences connus (un service d'avant la version 2), rien", () => {
    const base = input(TED, 1350).payload!;
    const old = { ...base, scenes: base.scenes.map((s) => ({ start: s.start, end: s.end, people: s.people, entry: s.entry, cut: s.cut })) };
    expect(at(TED, 1350, { payload: old })).toBe("pauses-inconnues");
  });
});

describe("les conditions", () => {
  it("une absence de quatre heures au moins, connue", () => {
    expect(at(TED, 1350, { lastPlayedAt: "2026-11-10T17:00:00.000Z" })).toBe("absence-courte");
    expect(at(TED, 1350, { lastPlayedAt: "2026-11-10T16:00:00.000Z" })).toEqual({ target: 1319.75, back: 30.25 });
    expect(at(TED, 200, { lastPlayedAt: null })).toBe("absence-inconnue");
    expect(at(TED, 200, { lastPlayedAt: "pas une date" })).toBe("absence-inconnue");
  });
  it("une analyse complète, mesurée, d'un titre qui parle", () => {
    const base = input(TED, 200).payload!;
    expect(at(TED, 200, { payload: null })).toBe("analyse-incomplète");
    expect(at(TED, 200, { payload: { ...base, status: "running" } })).toBe("analyse-incomplète");
    expect(at(TED, 200, { payload: { ...base, complete: false } })).toBe("analyse-incomplète");
    expect(at(TED, 200, { payload: { ...base, scenes: base.scenes.map((s) => ({ start: s.start, end: s.end, people: s.people })) } })).toBe("coupes-absentes");
    expect(at(TED, 200, { payload: { ...base, speechShare: undefined } })).toBe("parole-inconnue");
    expect(at(TED, 200, { payload: { ...base, speechShare: null } })).toBe("parole-inconnue");
    expect(at(TED, 200, { payload: { ...base, speechShare: 0.19 } })).toBe("peu-de-parole");
  });
  it("aucun geste avant la première image", () => {
    expect(at(TED, 200, { interrupted: "saut" })).toBe("saut");
    expect(at(TED, 200, { interrupted: "piste" })).toBe("piste");
  });
  it("ni dans le récap, ni dans les dernières scènes sans visage", () => {
    expect(at(TED, 200, { recapSkip: { start: 190, end: 230 } })).toBe("récap");
    const base = input(TED, 1700).payload!;
    const faceless = { ...base, scenes: base.scenes.map((s) => (s.start >= 1648.25 ? { ...s, people: [] } : s)) };
    expect(at(TED, 1700, { payload: faceless, creditsStart: null })).toBe("fin-sans-visages");
  });
  it("une frontière sans verdict entre la cible et la position bloque", () => {
    const base = input(TED, 1176).payload!;
    const unknown = { ...base, scenes: base.scenes.map((s) => (s.start === 1174.25 ? { start: s.start, end: s.end, people: s.people } : s)) };
    expect(at(TED, 1176, { payload: unknown })).toBe("coupe-inconnue");
  });
});

describe("la séance (sceneRestartSession)", () => {
  beforeEach(() => forgetSceneRestart());
  const ID = "a".repeat(32);

  it("gèle la dernière lecture à l'ouverture : la relecture pendant la séance ne la change pas", () => {
    noteLastPlayedAt(ID, "2026-11-09T21:00:00.000Z");
    beginSceneRestart(ID);
    noteLastPlayedAt(ID, "2026-11-10T19:59:00.000Z"); // un rapport de progression l'a avancée
    expect(sceneRestartState(ID)?.lastPlayedAt).toBe("2026-11-09T21:00:00.000Z");
    // Lue après le montage des commandes : prise, la séance ne la connaissait pas.
    forgetSceneRestart();
    beginSceneRestart(ID);
    noteLastPlayedAt(ID, YESTERDAY);
    expect(sceneRestartState(ID)?.lastPlayedAt).toBe(YESTERDAY);
  });

  it("une fois par séance : une reconstruction ou un passage de main ne redécide rien", () => {
    beginSceneRestart(ID);
    noteSceneRestartVerdict(ID, "non:absence-courte");
    beginSceneRestart(ID); // les commandes remontées
    noteSceneRestartVerdict(ID, "proposé", { target: 10 });
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "non:absence-courte" });
    // La ligne `stop` partie : la prochaine ouverture repart de zéro.
    endSceneRestart(ID);
    noteLastPlayedAt(ID, YESTERDAY);
    beginSceneRestart(ID);
    expect(sceneRestartState(ID)).toMatchObject({ live: true, lastPlayedAt: YESTERDAY });
    expect(sceneRestartLogFields(ID)).toEqual({});
  });

  it("un saut avant la décision est retenu ; l'issue n'est dite qu'une fois", () => {
    beginSceneRestart(ID);
    noteSceneRestartInterrupt(ID, "saut");
    expect(sceneRestartState(ID)?.interrupted).toBe("saut");
    noteSceneRestartVerdict(ID, "proposé", { target: 131.923, shownAt: NOW });
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "proposé:fermé" });
    expect(noteSceneRestartOutcome(ID, "utilisé")).toBe(true);
    expect(noteSceneRestartOutcome(ID, "saut")).toBe(false);
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "proposé:utilisé" });
  });

  it("rien n'est retenu sans séance (acteurs à l'écran absents)", () => {
    noteSceneRestartVerdict(ID, "aurait-proposé");
    noteSceneRestartInterrupt(ID, "piste");
    expect(sceneRestartLogFields(ID)).toEqual({});
  });
});

describe("le journal", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-log-"));
    vi.resetModules();
    vi.doMock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
  });
  afterEach(() => {
    vi.doUnmock("@/lib/dataDir");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const lines = () =>
    fs
      .readFileSync(path.join(dir, "logs", "player.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  it("accepte `debut-scene` et garde `sceneRestart` hors plafond, sur un bilan plein", async () => {
    const { logPlaybackEvent, isPlayerEventKind } = await import("@/lib/playerLog");
    expect(isPlayerEventKind("debut-scene")).toBe(true);
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`f${i}`, i]));
    logPlaybackEvent("louis", "stop", { ...many, sceneRestart: "aurait-proposé" });
    logPlaybackEvent("louis", "stop", { sceneRestart: "non:coupe-parole" });
    logPlaybackEvent("louis", "stop", { sceneRestart: "proposé:utilisé" });
    logPlaybackEvent("louis", "debut-scene", { outcome: "ignoré", target: 131.923, back: 68 });
    const [full, refused, used, line] = lines();
    expect(full.sceneRestart).toBe("aurait-proposé");
    expect(refused.sceneRestart).toBe("non:coupe-parole");
    expect(used.sceneRestart).toBe("proposé:utilisé");
    expect(line).toMatchObject({ kind: "debut-scene", outcome: "ignoré", target: 131.923, back: 68 });
  });

  it("n'écrit qu'une valeur de la forme attendue", async () => {
    const { logPlaybackEvent } = await import("@/lib/playerLog");
    logPlaybackEvent("louis", "stop", { sceneRestart: "<script>" });
    logPlaybackEvent("louis", "stop", { sceneRestart: "proposé:peut-être" });
    logPlaybackEvent("louis", "stop", { sceneRestart: 3 });
    for (const line of lines()) expect(line).not.toHaveProperty("sceneRestart");
  });
});

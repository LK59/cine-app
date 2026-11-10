import { describe, it, expect } from "vitest";
import { sofarCut, sofarCutDetail, sofarMark, SOFAR_BUCKET_S, SOFAR_PRESENT_STEP_S, SOFAR_SCENE_STEP_S } from "@/lib/ask/sofarCut";
import * as client from "@/lib/ask/client";
import * as server from "@/lib/ask/sofar";

// La coupe de « Jusqu'ici » (DECISIONS.md §139) : une seule fonction pour le client et le serveur. Depuis 10.30.1,
// le début de la scène d'« À l'écran » en cours (par pas de deux minutes dans une longue scène) ; sans scènes, la
// marque des cinq minutes.

const payload = (starts: number[], complete = true, analyzedUntil = 0) => ({ complete, analyzedUntil, scenes: starts.map((start) => ({ start })) });

// Les scènes réelles de *Ted Lasso* S01E09 (service X-Ray, 09/11/2026), [début, fin].
const S01E09: [number, number][] = [
  [0, 86.5], [86.5, 110.944], [131.923, 237.673], [237.673, 348.75], [348.75, 363.25], [363.25, 451.5], [451.5, 631],
  [631, 662.25], [662.25, 835.25], [835.25, 910.75], [910.75, 945], [945, 957], [957, 995.25], [995.25, 1020.75],
  [1020.75, 1031.25], [1031.25, 1086.25], [1086.25, 1174.25], [1174.25, 1319.75], [1319.75, 1476], [1476, 1648.25],
  [1648.25, 1714.5], [1714.5, 1869.25],
];
const e09 = { complete: true, analyzedUntil: 1878.127, scenes: S01E09.map(([start, end]) => ({ start, end })) };

describe("sofarCut", () => {
  it("Rebecca à 13 min 43 (S01E09) : sa confession à Ted (10 min 57 à 13 min 10) est dans le texte", () => {
    // La règle d'avant coupait à 7 min 31 (la dernière scène commencée avant 10 min) : la confession manquait.
    // Le seul début de la scène en cours (11 min 02) la laissait encore dehors — elle est dans cette scène.
    const cut = sofarCut(823, e09);
    expect(cut).toBe(782);
    // « Je vous ai embauché pour faire perdre l'équipe. » (673 s), « …le faire souffrir… » (708 s), le pardon de Ted (743 s).
    for (const t of [673.3, 707.9, 742.7]) expect(t).toBeLessThan(cut);
    expect(cut).toBeLessThanOrEqual(823);
  });

  it("le début de la scène en cours : Nathan à 6 min 31, Beard à 6 min 38 → 6 min 03", () => {
    expect(sofarCut(391, e09)).toBe(363);
    expect(sofarCut(398, e09)).toBe(363);
    // Pile au début d'une scène : elle commence là.
    expect(sofarCut(451.5, e09)).toBe(363);
    expect(sofarCut(452, e09)).toBe(451);
  });

  it(`une longue scène avance par pas de ${SOFAR_SCENE_STEP_S} s depuis son début`, () => {
    // Roy à 27 min 18 : la scène 24 min 36 – 27 min 28, un pas passé.
    expect(sofarCut(1638, e09)).toBe(1476 + SOFAR_SCENE_STEP_S);
    expect(sofarCut(1476 + SOFAR_SCENE_STEP_S - 1, e09)).toBe(1476);
  });

  it("entre deux scènes : la fin de la précédente, vue en entier", () => {
    expect(sofarCut(120, e09)).toBe(110);
  });

  it("le client, avec sa position exacte, coupe comme le serveur, qui la reçoit en secondes entières", () => {
    for (let pos = 0; pos < 1880; pos += 0.37) {
      expect(sofarCut(pos, e09)).toBe(sofarCut(Math.floor(pos), e09));
    }
    // Le cas qui divergeait : un début de scène à 662,25 s.
    expect(sofarCut(662.5, e09)).toBe(sofarCut(662, e09));
  });

  it("jamais après la position, jamais négative, toujours un début de scène, une fin, ou un pas", () => {
    const starts = [0, 130, 420, 760, 905];
    for (let pos = 0; pos < 1200; pos += 37) {
      const cut = sofarCut(pos, payload(starts));
      expect(cut).toBeLessThanOrEqual(pos);
      expect(cut).toBeGreaterThanOrEqual(0);
      if (cut > 0) expect(starts.some((s) => cut >= s && (cut - s) % SOFAR_SCENE_STEP_S === 0)).toBe(true);
    }
  });

  it("sans scènes, analyse qui ne va pas jusqu'à la position, aucune scène avant elle : la marque des cinq minutes", () => {
    expect(sofarMark(17 * 60 + 18)).toBe(900);
    expect(sofarCut(12 * 60, null)).toBe(600);
    expect(sofarCut(12 * 60, payload([]))).toBe(600);
    expect(sofarCut(12 * 60, payload([0, 300], false, 450))).toBe(600);
    expect(sofarCut(12 * 60, payload([0, 300], false, 750))).toBe(300 + 3 * SOFAR_SCENE_STEP_S);
    expect(sofarCut(12 * 60, payload([800, 900]))).toBe(600);
    expect(sofarCut(null, payload([0]))).toBe(0);
    expect(sofarCut(-3, payload([0]))).toBe(0);
  });

  it("le client et le serveur lisent la même tranche, de la même source", () => {
    expect(client.SOFAR_BUCKET_S).toBe(SOFAR_BUCKET_S);
    expect(server.SOFAR_BUCKET_S).toBe(SOFAR_BUCKET_S);
  });
});

// Les scènes de *Ted Lasso* S01E09 avec leurs présences, telles que le lecteur les reçoit (analyse du 10/11/2026 : la
// conférence de presse 320 – 348,75 est une scène à part). Identifiants TMDB.
const REBECCA = 1278487, KEELEY = 36594, TRENT = 19775, TED = 58224, ROY = 21422, NATE = 1509615;
const E09_PEOPLE: [number, number, number[]][] = [
  [0, 86.5, [ROY, TED]],
  [86.5, 110.944, [ROY]],
  [131.923, 237.673, [REBECCA, TED, KEELEY]],
  [237.673, 320, [REBECCA, NATE, KEELEY]],
  [320, 348.75, [TED, TRENT, 1113365, NATE, 2303312]],
  [348.75, 363.25, [TED, 1113365, NATE]],
  [363.25, 451.5, [TED, NATE, 1113365]],
  [451.5, 631, [REBECCA, 34257, TED]],
  [631, 662.25, [REBECCA, TED]],
  [662.25, 835.25, [REBECCA, TED]],
  [835.25, 910.75, [TED, 2627590, 2519330, 1113365]],
];
const e09p = {
  complete: true,
  analyzedUntil: 1878.127,
  scenes: E09_PEOPLE.map(([start, end, ids]) => ({ start, end, people: ids.map((personId) => ({ personId })) })),
};

describe("sofarCut — une première présence dans la scène en cours (10.30.2)", () => {
  it("Trent Crimm à 5 min 40, dans la conférence de presse (5 min 20 – 5 min 48) : 5 min 30, pas 5 min 20", () => {
    // Coupé au début de la scène, il n'avait rien avant : « Trent Crimm n'a pas encore eu de moment à lui. »
    expect(sofarCutDetail(340, e09p, TRENT)).toEqual({ cutS: 330, why: "present" });
    expect(sofarCut(340.8, e09p, TRENT)).toBe(330);
    // Sans la personne, la coupe d'avant.
    expect(sofarCutDetail(340, e09p)).toEqual({ cutS: 320, why: "scene" });
  });

  it("Rebecca à 13 min 43 et Keeley à 5 min, déjà vues avant la scène en cours : inchangées", () => {
    expect(sofarCutDetail(823, e09p, REBECCA)).toEqual({ cutS: 782, why: "step" });
    expect(sofarCutDetail(300, e09p, KEELEY)).toEqual({ cutS: 237, why: "scene" });
  });

  it("une personne absente de la scène en cours : inchangée, qu'elle ait paru avant ou jamais", () => {
    expect(sofarCut(340, e09p, REBECCA)).toBe(320);
    expect(sofarCut(340, e09p, 999)).toBe(320);
    // Trent plus tard, hors de sa scène : la coupe ordinaire.
    expect(sofarCutDetail(400, e09p, TRENT)).toEqual({ cutS: 363, why: "scene" });
  });

  it(`la demi-minute ne recule jamais la coupe, ne dépasse jamais la position, et suit la seconde entière`, () => {
    // 325 : la demi-minute (300) tombe avant le début de la scène (320) — la coupe ordinaire reste.
    expect(sofarCutDetail(325, e09p, TRENT)).toEqual({ cutS: 320, why: "scene" });
    for (let pos = 320; pos < 349; pos += 0.37) {
      const cut = sofarCut(pos, e09p, TRENT);
      expect(cut).toBeLessThanOrEqual(pos);
      expect(cut).toBeGreaterThanOrEqual(320);
      expect(cut).toBe(sofarCut(Math.floor(pos), e09p, TRENT));
      if (cut > 320) expect(cut % SOFAR_PRESENT_STEP_S).toBe(0);
    }
  });

  it("le repli et l'entre-deux scènes disent leur raison", () => {
    expect(sofarCutDetail(12 * 60, null, TRENT)).toEqual({ cutS: 600, why: "fallback" });
    expect(sofarCutDetail(null, e09p, TRENT)).toEqual({ cutS: 0, why: "fallback" });
    expect(sofarCutDetail(120, e09p, ROY)).toEqual({ cutS: 110, why: "scene" });
  });
});

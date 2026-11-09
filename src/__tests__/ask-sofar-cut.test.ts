import { describe, it, expect } from "vitest";
import { sofarCut, sofarMark, SOFAR_BUCKET_S, SOFAR_SCENE_STEP_S } from "@/lib/ask/sofarCut";
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

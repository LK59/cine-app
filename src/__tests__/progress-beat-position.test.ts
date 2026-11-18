import { describe, it, expect } from "vitest";
import { beatStopFields, noteBeatPosition } from "@/lib/progressBeat";
import { PlayerLifecycle } from "@/lib/playerLifecycle";

/** La mesure du 18/11/2026 (*Drive* rouvert à 30 min de la fin) : le dernier relevé, et d'où vient la reprise. */
describe("le dernier relevé de position", () => {
  it("rien tant qu'aucun relevé n'est parti ; sinon la position, l'âge, et l'échec seulement s'il y en a un", () => {
    expect(beatStopFields("x", 0)).toEqual({});
    noteBeatPosition("x", 4258.97, true, 1_000);
    expect(beatStopFields("x", 31_000)).toEqual({ "diag.beatPos": 4259, "diag.beatAgoS": 30 });
    noteBeatPosition("x", 5800, false, 40_000);
    expect(beatStopFields("x", 41_000)).toEqual({ "diag.beatPos": 5800, "diag.beatAgoS": 1, "diag.beatOk": false });
  });
  it("borné : les plus anciens titres sont oubliés", () => {
    for (let i = 0; i < 25; i++) noteBeatPosition(`t${i}`, i, true, 0);
    expect(beatStopFields("t0", 0)).toEqual({});
    expect(beatStopFields("t24", 0)).toEqual({ "diag.beatPos": 24, "diag.beatAgoS": 0 });
  });
});

describe("openingSource", () => {
  it("dit qui a fourni la position d'ouverture", () => {
    const life = new PlayerLifecycle();
    expect(life.openingSource(false, 4253.9, 0)).toBe("appelant");
    expect(life.openingSource(false, undefined, 120)).toBe("serveur");
    expect(life.openingSource(false, null, undefined)).toBe("début");
    expect(life.openingSource(true, 10, 20)).toBe("lecture");
  });
});

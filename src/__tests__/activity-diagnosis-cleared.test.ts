import { describe, it, expect, vi, beforeEach } from "vitest";

/** Effacer un titre du diagnostic (06/10/2026) : il revient s'il échoue de nouveau. */
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/settings/store", () => ({
  readOverride: (k: string) => store.get(k) ?? null,
  writeOverride: (k: string, v: string) => void store.set(k, v),
}));

import { clearDiagnosis, clearedDiagnosis, withoutCleared } from "@/lib/activity/diagnosisCleared";

beforeEach(() => store.clear());

const item = (key: string, lastFailure: number) => ({ key, lastFailure });

describe("les titres effacés du diagnostic", () => {
  it("disparaissent tant qu'ils n'échouent pas de nouveau", () => {
    clearDiagnosis(["le-mans", "dirty"], 1000);
    const cleared = clearedDiagnosis();
    expect(withoutCleared([item("le-mans", 900), item("dirty", 1000), item("autre", 500)], cleared).map((d) => d.key)).toEqual(["autre"]);
  });

  it("reviennent après un nouvel échec", () => {
    clearDiagnosis(["le-mans"], 1000);
    expect(withoutCleared([item("le-mans", 1500)], clearedDiagnosis()).map((d) => d.key)).toEqual(["le-mans"]);
  });

  it("oublient les effacements de plus d'un mois, que le diagnostic ne regarde plus", () => {
    clearDiagnosis(["vieux"], 0);
    clearDiagnosis(["neuf"], 40 * 24 * 3600_000);
    expect(Object.keys(clearedDiagnosis())).toEqual(["neuf"]);
  });

  it("résiste à une valeur illisible", () => {
    store.set("__DIAGNOSIS_CLEARED", "pas du json");
    expect(clearedDiagnosis()).toEqual({});
  });
});

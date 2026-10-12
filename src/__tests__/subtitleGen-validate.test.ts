import { describe, it, expect } from "vitest";
import { validateBatch } from "@/lib/subtitleGen/validate";

/** La validation stricte d'un lot (DECISIONS.md §69). */
const req = [
  { id: 10, source: "Where were you last night?" },
  { id: 11, source: "I was at the station, waiting for the train." },
  { id: 12, source: "[door slams]" },
];
const ok = { translations: [{ i: 10, text: "Où étais-tu hier soir ?" }, { i: 11, text: "J'étais à la gare,\nà attendre le train." }, { i: 12, text: "[une porte claque]" }] };

describe("validateBatch", () => {
  it("accepte un lot complet", () => {
    const v = validateBatch(req, ok);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.texts.get(11)).toBe("J'étais à la gare,\nà attendre le train.");
  });
  it("refuse un identifiant manquant (deux répliques fusionnées)", () => {
    expect(validateBatch(req, { translations: ok.translations.slice(0, 2) })).toMatchObject({ ok: false, problem: "manquant" });
  });
  it("refuse un identifiant en trop", () => {
    expect(validateBatch(req, { translations: [...ok.translations, { i: 13, text: "x" }] })).toMatchObject({ ok: false, problem: "en-trop" });
  });
  it("refuse un identifiant en double", () => {
    expect(validateBatch(req, { translations: [...ok.translations.slice(0, 2), { i: 11, text: "x" }] })).toMatchObject({ ok: false, problem: "doublon" });
  });
  it("refuse une ligne vide", () => {
    const v = validateBatch(req, { translations: [ok.translations[0], { i: 11, text: "  " }, ok.translations[2]] });
    expect(v).toMatchObject({ ok: false, problem: "lignes", bad: [11] });
  });
  it("refuse plus de deux lignes", () => {
    const v = validateBatch(req, { translations: [ok.translations[0], { i: 11, text: "a\nb\nc" }, ok.translations[2]] });
    expect(v).toMatchObject({ ok: false, bad: [11] });
  });
  it("refuse une phrase restée dans la langue source", () => {
    const v = validateBatch(req, { translations: [ok.translations[0], { i: 11, text: req[1].source }, ok.translations[2]] });
    expect(v).toMatchObject({ ok: false, bad: [11] });
  });
  it("refuse un lot resté en majorité dans la langue source", () => {
    const lines = [
      { id: 1, source: "Come on, let's go." },
      { id: 2, source: "Not now, please." },
      { id: 3, source: "You never listen to me." },
    ];
    const v = validateBatch(lines, { translations: lines.map((l) => ({ i: l.id, text: l.source })) });
    expect(v).toMatchObject({ ok: false, problem: "langue-source" });
  });
  it("laisse passer un nom ou un son court rendu à l'identique", () => {
    const v = validateBatch([{ id: 1, source: "Paul!" }], { translations: [{ i: 1, text: "Paul!" }] });
    expect(v.ok).toBe(true);
  });
  it("refuse une réponse sans la bonne forme", () => {
    expect(validateBatch(req, { nope: [] })).toMatchObject({ ok: false, problem: "forme" });
  });
});

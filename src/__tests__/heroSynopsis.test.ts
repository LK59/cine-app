import { describe, it, expect } from "vitest";
import { splitSentences, sentencesThatFit } from "@/lib/heroSynopsis";

describe("splitSentences", () => {
  it("coupe aux fins de phrase", () => {
    expect(splitSentences("Ancien Marine brisé, Tommy rentre au pays. Son père accepte de l'entraîner. Le tournoi approche !")).toEqual([
      "Ancien Marine brisé, Tommy rentre au pays.",
      "Son père accepte de l'entraîner.",
      "Le tournoi approche !",
    ]);
  });

  it("ne coupe pas sur une abréviation", () => {
    // « M. » suivi d'une majuscule ressemble à une fin de phrase : trop court pour en être une.
    expect(splitSentences("M. Smith quitte Chicago pour toujours. Il ne reviendra jamais plus en ville.")).toEqual([
      "M. Smith quitte Chicago pour toujours.",
      "Il ne reviendra jamais plus en ville.",
    ]);
  });

  it("ne coupe pas avant une minuscule", () => {
    expect(splitSentences("Il travaille chez etc. depuis toujours et ça lui convient très bien.")).toHaveLength(1);
  });

  it("garde un texte sans ponctuation finale en une seule phrase", () => {
    expect(splitSentences("Une famille face à la tempête")).toEqual(["Une famille face à la tempête"]);
  });

  it("garde une vraie phrase courte comme une phrase", () => {
    expect(splitSentences("Une longue première phrase qui raconte tout. Tout change.")).toEqual([
      "Une longue première phrase qui raconte tout.",
      "Tout change.",
    ]);
  });

  it("reconnaît les abréviations courantes", () => {
    expect(splitSentences("Le Dr. Jones enseigne à St. Louis depuis dix ans. Un jour, tout bascule.")).toEqual([
      "Le Dr. Jones enseigne à St. Louis depuis dix ans.",
      "Un jour, tout bascule.",
    ]);
  });
});

describe("sentencesThatFit", () => {
  const within = (n: number) => (s: string) => s.length <= n;
  const text = "Première phrase assez longue pour compter. Deuxième phrase tout aussi longue que la première. Troisième.";

  it("garde toutes les phrases entières qui tiennent", () => {
    expect(sentencesThatFit(text, within(1000))).toBe(text);
    expect(sentencesThatFit(text, within(95))).toBe(
      "Première phrase assez longue pour compter. Deuxième phrase tout aussi longue que la première."
    );
    expect(sentencesThatFit(text, within(50))).toBe("Première phrase assez longue pour compter.");
  });

  it("rend null quand même la première déborde — la bannière retombe sur le fondu", () => {
    expect(sentencesThatFit(text, within(10))).toBeNull();
  });

  it("un texte vide reste vide", () => {
    expect(sentencesThatFit("", within(10))).toBe("");
  });
});

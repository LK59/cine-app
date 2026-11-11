import { describe, it, expect } from "vitest";
import { buildQuiz, type QuizTitle } from "@/lib/quiz/build";

/** Un hasard reproductible. */
function seeded(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
const film = (n: number, extra: Partial<QuizTitle> = {}): QuizTitle => ({
  title: `Film ${n}`,
  year: 1990 + n,
  genres: [n % 2 ? "Drame" : "Comédie"],
  poster: `https://image.tmdb.org/t/p/w500/p${n}.jpg`,
  backdrop: `https://image.tmdb.org/t/p/w1280/b${n}.jpg`,
  tagline: `Une accroche assez longue pour le film ${n}`,
  cast: ["Une", "Deux", "Trois", "Quatre"],
  ...extra,
});

/**
 * La préparation d'une partie de « Devine le film » (DECISIONS.md §146) : des manches jouables, une réponse parmi
 * quatre propositions distinctes, des leurres du même genre de préférence, aucune adresse d'image qui dise le film.
 */
describe("préparer une partie", () => {
  it("dix manches, quatre propositions distinctes, la réponse au bon rang, les images par jeton", () => {
    const titles = Array.from({ length: 30 }, (_, i) => film(i));
    const quiz = buildQuiz(titles, "mixte", (src) => `/api/quiz/image?t=${Buffer.from(src).toString("base64url").slice(0, 6)}`, seeded())!;
    expect(quiz.rounds).toHaveLength(10);
    quiz.rounds.forEach((round, i) => {
      expect(new Set(round.choices).size).toBe(4);
      expect(quiz.answers[i]).toBeGreaterThanOrEqual(0);
      if (round.image) expect(round.image).not.toMatch(/tmdb|Film/);
    });
    // Les leurres partagent le genre de la réponse (le pool en a assez).
    for (const [i, round] of quiz.rounds.entries()) {
      const answer = round.choices[quiz.answers[i]];
      const parity = Number(answer.split(" ")[1]) % 2;
      expect(round.choices.filter((c) => Number(c.split(" ")[1]) % 2 === parity)).toHaveLength(4);
    }
  });

  it("« affiches » : que des affiches ; un film sans affiche n'y entre pas", () => {
    const titles = [...Array.from({ length: 12 }, (_, i) => film(i)), film(99, { poster: null })];
    const quiz = buildQuiz(titles, "affiches", (s) => s, seeded())!;
    expect(quiz.rounds.every((r) => r.kind === "poster")).toBe(true);
    expect(quiz.rounds.map((r, i) => r.choices[quiz.answers[i]])).not.toContain("Film 99");
  });

  it("l'accroche ne dit pas le titre", () => {
    const titles = Array.from({ length: 8 }, (_, i) => film(i, { poster: null, backdrop: null, cast: [], tagline: `Bienvenue dans Film ${i}, le grand film` }));
    const quiz = buildQuiz(titles, "mixte", (s) => s, seeded())!;
    for (const [i, round] of quiz.rounds.entries()) expect(round.text).not.toContain(round.choices[quiz.answers[i]]);
  });

  it("une bibliothèque commune trop petite : pas de partie", () => {
    expect(buildQuiz([film(1), film(2), film(3)], "mixte", (s) => s)).toBeNull();
  });
});

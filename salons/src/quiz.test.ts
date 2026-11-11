import { test } from "node:test";
import assert from "node:assert/strict";
import { INTRO_MS, parseGameData, pointsFor, questionMs, QuizGame, REVEAL_MS, type QuizGameData } from "./quiz.ts";

const round = (n: number) => ({ kind: "tagline" as const, text: `Indice ${n}`, choices: ["A", "B", "C", "D"] as [string, string, string, string] });
const data = (rounds = 3, variant: QuizGameData["variant"] = "mixte"): QuizGameData => ({ id: "partie-0001", variant, rounds: Array.from({ length: rounds }, (_, i) => round(i)) });

test("les points : plus vite, plus ; la série et la première bonne réponse rapportent", () => {
  assert.equal(pointsFor(0, 1, false), 1000);
  assert.equal(pointsFor(1, 1, false), 300);
  assert.equal(pointsFor(0, 3, false), 1200);
  assert.equal(pointsFor(0, 99, true), 1000 + 200 + 500);
});

test("« rapide » raccourcit les manches de 15 à 6 s ; les autres variantes gardent 20 s", () => {
  assert.equal(questionMs("rapide", 0, 10), 15_000);
  assert.equal(questionMs("rapide", 9, 10), 6_000);
  assert.equal(questionMs("mixte", 9, 10), 20_000);
});

test("une partie à deux : annonce, question, réponses, révélation dès que tous ont répondu, fin", () => {
  const g = new QuizGame(data(2), [1, 3], [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }], 0);
  assert.equal(g.view().phase, "intro");
  assert.equal(g.view().clue, null);
  assert.equal(g.answer("a", 0, 1, 100), null, "pas pendant l'annonce");
  g.tick(INTRO_MS);
  assert.equal(g.view().phase, "question");
  assert.equal(g.view().answer, null, "la réponse ne sort pas avant la révélation");
  assert.equal(g.answer("a", 0, 1, INTRO_MS), true);
  assert.equal(g.answer("a", 0, 2, INTRO_MS + 10), null, "une seule réponse par manche");
  assert.equal(g.view().answered.length, 1);
  assert.equal(g.answer("b", 0, 0, INTRO_MS + 50), false);
  const v = g.view();
  assert.equal(v.phase, "reveal");
  assert.equal(v.answer, 1);
  assert.equal(v.gains!.a, 1000 + 200);
  assert.equal(v.gains!.b, 0);
  g.tick(v.endsAt);
  assert.equal(g.view().phase, "question");
  assert.equal(g.view().round, 1);
  // Personne ne répond : la manche se termine à l'heure, puis la partie.
  g.tick(g.view().endsAt);
  assert.equal(g.view().phase, "reveal");
  g.tick(g.view().endsAt + REVEAL_MS);
  assert.equal(g.view().phase, "end");
  const final = g.final();
  assert.deepEqual(final.find((p) => p.id === "a"), { id: "a", name: "Alice", score: 1200, correct: 1, total: 2, bestStreak: 1 });
});

test("seul : pas de bonus de première réponse ; une série se perd sur une manche sans réponse", () => {
  const g = new QuizGame(data(3), [0, 0, 0], [{ id: "a", name: "Alice" }], 0);
  g.tick(INTRO_MS);
  g.answer("a", 0, 0, INTRO_MS);
  assert.equal(g.view().gains!.a, 1000);
  g.tick(g.view().endsAt);
  g.tick(g.view().endsAt);
  assert.equal(g.view().phase, "reveal", "manche sans réponse");
  g.tick(g.view().endsAt);
  g.answer("a", 2, 0, g.view().startsAt);
  assert.equal(g.view().gains!.a, 1000, "la série est repartie de un");
});

test("une partie reçue est vérifiée champ par champ", () => {
  assert.ok(parseGameData(data(3)));
  assert.equal(parseGameData({ ...data(3), rounds: data(2).rounds }), null);
  assert.equal(parseGameData({ ...data(3), variant: "triche" }), null);
  assert.equal(parseGameData({ ...data(3), rounds: [{ ...round(0), image: "https://ailleurs.example/x.jpg" }, round(1), round(2)] }), null);
  assert.equal(parseGameData({ ...data(3), rounds: [{ ...round(0), choices: ["A", "B"] }, round(1), round(2)] }), null);
});

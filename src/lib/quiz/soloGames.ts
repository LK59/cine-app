import { pointsFor } from "../../../salons/src/quiz";

/**
 * Les parties jouées seul (sans service), gardées en mémoire le temps de les jouer (DECISIONS.md §146) : quand le
 * bilan revient, l'application recompte elle-même les points à partir des réponses données et des siennes — un score
 * ne s'écrit pas en l'annonçant. Une partie ne se rend qu'une fois, et seulement par le compte qui l'a demandée.
 *
 * Sur `globalThis` : chaque route est un point d'entrée à part, avec sa propre copie des modules (CLAUDE.md, cache).
 */
interface SoloGame {
  sub: string;
  variant: string;
  answers: number[];
  exp: number;
}

const STORE = Symbol.for("cine-app.quiz.solo");
const games = ((globalThis as Record<symbol, unknown>)[STORE] ??= new Map<string, SoloGame>()) as Map<string, SoloGame>;
const TTL_MS = 2 * 60 * 60_000;
const MAX = 500;

export function rememberSoloGame(id: string, sub: string, variant: string, answers: number[], now = Date.now()): void {
  for (const [key, game] of games) if (game.exp <= now) games.delete(key);
  if (games.size >= MAX) games.delete(games.keys().next().value!);
  games.set(id, { sub, variant, answers, exp: now + TTL_MS });
}

export interface SoloPick {
  /** La proposition choisie (0 à 3), ou `null` sans réponse. */
  choice: number | null;
  /** Où dans le temps de la manche la réponse est venue, de 0 à 1. */
  at: number;
}

/** Le bilan recompté d'une partie seule, ou `null` (inconnue, d'un autre compte, déjà rendue, mal formée). */
export function settleSoloGame(id: string, sub: string, picks: unknown, now = Date.now()): { variant: string; score: number; correct: number; total: number; bestStreak: number } | null {
  const game = games.get(id);
  if (!game || game.sub !== sub || game.exp <= now || !Array.isArray(picks) || picks.length !== game.answers.length) return null;
  games.delete(id);
  let score = 0;
  let correct = 0;
  let streak = 0;
  let bestStreak = 0;
  game.answers.forEach((answer, i) => {
    const pick = picks[i] as SoloPick | null;
    const choice = pick && Number.isInteger(pick.choice) ? pick.choice : null;
    const at = pick && typeof pick.at === "number" && Number.isFinite(pick.at) ? Math.min(1, Math.max(0, pick.at)) : 1;
    if (choice === answer) {
      streak += 1;
      correct += 1;
      bestStreak = Math.max(bestStreak, streak);
      score += pointsFor(at, streak, false);
    } else streak = 0;
  });
  return { variant: game.variant, score, correct, total: game.answers.length, bestStreak };
}

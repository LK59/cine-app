import { randomBytes } from "node:crypto";
import type { ClueKind, QuizRound, QuizVariant } from "../../../salons/src/quiz";

/**
 * « Devine le film » (DECISIONS.md §146) : préparer une partie à partir des films que **tous** les joueurs peuvent
 * voir. Pure : les titres arrivent déjà filtrés (`candidates.ts`), le hasard est passé en paramètre — de quoi
 * l'éprouver sans réseau.
 *
 * Chaque manche : un film, un indice (affiche sans texte quand TMDB en a une — sinon l'affiche, qui se précisera
 * lentement ; image du film ; accroche ; distribution), et trois leurres pris de préférence parmi les films qui
 * partagent un de ses genres, pour que la réponse ne saute pas aux yeux.
 */
export interface QuizTitle {
  title: string;
  year: number | null;
  genres: string[];
  /** Les images, en adresses TMDB absolues ; `null` quand le film n'en a pas. */
  poster: string | null;
  backdrop: string | null;
  tagline: string | null;
  cast: string[];
}

export interface BuiltQuiz {
  id: string;
  variant: QuizVariant;
  rounds: QuizRound[];
  answers: number[];
}

export const QUIZ_ROUNDS = 10;

/** Les indices qu'un film peut donner, selon la variante. */
function cluesOf(t: QuizTitle, variant: QuizVariant): ClueKind[] {
  const kinds: ClueKind[] = [];
  if (t.poster) kinds.push("poster");
  if (variant === "affiches") return kinds;
  if (t.backdrop) kinds.push("backdrop");
  if (t.tagline && t.tagline.length >= 12) kinds.push("tagline");
  if (t.cast.length >= 3) kinds.push("cast");
  return kinds;
}

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** L'accroche, sans le titre s'il y figure (« … » à sa place). */
function maskTitle(text: string, title: string): string {
  const needle = fold(title).trim();
  if (needle.length < 3) return text;
  const index = fold(text).indexOf(needle);
  return index < 0 ? text : `${text.slice(0, index)}…${text.slice(index + needle.length)}`;
}

function shuffle<T>(list: T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Une partie de `count` manches, ou `null` si la bibliothèque commune est trop petite (il faut au moins quatre
 * titres distincts par manche, et autant de films à faire deviner que de manches).
 */
export function buildQuiz(
  titles: QuizTitle[],
  variant: QuizVariant,
  imageUrl: (src: string) => string,
  random: () => number = Math.random,
  count = QUIZ_ROUNDS
): BuiltQuiz | null {
  // Un titre par nom : deux films homonymes rendraient une manche impossible.
  const byName = new Map<string, QuizTitle>();
  for (const t of titles) if (t.title && !byName.has(fold(t.title))) byName.set(fold(t.title), t);
  const pool = [...byName.values()];
  const playable = shuffle(
    pool.filter((t) => cluesOf(t, variant).length > 0),
    random
  ).slice(0, count);
  if (playable.length < Math.min(count, 3) || pool.length < 4) return null;

  const rounds: QuizRound[] = [];
  const answers: number[] = [];
  for (const film of playable) {
    const kinds = cluesOf(film, variant);
    const kind = kinds[Math.floor(random() * kinds.length)];
    // Des leurres du même genre d'abord, puis n'importe lesquels.
    const others = pool.filter((t) => t !== film);
    const close = shuffle(
      others.filter((t) => t.genres.some((g) => film.genres.includes(g))),
      random
    );
    const decoys: QuizTitle[] = [];
    for (const t of [...close, ...shuffle(others, random)]) {
      if (decoys.length === 3) break;
      if (!decoys.includes(t)) decoys.push(t);
    }
    const choices = shuffle([film, ...decoys], random);
    answers.push(choices.indexOf(film));
    const round: QuizRound = { kind, choices: choices.map((t) => t.title) as QuizRound["choices"] };
    if (kind === "poster") round.image = imageUrl(film.poster!);
    else if (kind === "backdrop") round.image = imageUrl(film.backdrop!);
    else if (kind === "tagline") {
      round.text = maskTitle(film.tagline!, film.title).slice(0, 400);
      round.year = film.year;
    } else {
      round.text = film.cast.slice(0, 5).join("\n").slice(0, 400);
      round.year = film.year;
    }
    rounds.push(round);
  }
  return { id: `q-${randomBytes(9).toString("base64url")}`, variant, rounds, answers };
}

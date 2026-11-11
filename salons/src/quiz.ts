/**
 * « Devine le film » : le moteur d'une partie, sans réseau ni horloge propre.
 *
 * **Un seul moteur pour les deux façons de jouer** : le service le fait tourner pour un salon (il tient alors le
 * chronomètre et les scores pour tous), et le chalet le fait tourner lui-même quand on joue seul, sans service
 * (`immersion/src/game/`). Les points se comptent donc exactement de la même façon des deux côtés.
 *
 * Une partie : quelques secondes d'annonce, puis des manches — un indice qui se précise, quatre propositions, un
 * temps imparti — chacune suivie de la réponse. Répondre vite rapporte plus ; une série de bonnes réponses ajoute
 * un bonus ; la première bonne réponse d'une manche, à plusieurs, aussi. Une réponse fausse bloque le joueur pour
 * la manche. La manche s'arrête dès que tout le monde a répondu.
 *
 * Les bonnes réponses ne sont **pas** dans ce que voient les joueurs (`QuizView`) avant la révélation de chaque
 * manche : à plusieurs, elles arrivent scellées au service (`seal.ts`), que lui seul ouvre.
 */
export type QuizVariant = "mixte" | "affiches" | "rapide";
export const QUIZ_VARIANTS: readonly QuizVariant[] = ["mixte", "affiches", "rapide"];

export type ClueKind = "poster" | "backdrop" | "tagline" | "cast";

/** Une manche telle que les joueurs la voient : l'indice et les quatre propositions, pas la réponse. */
export interface QuizRound {
  kind: ClueKind;
  /** L'image de l'indice (affiche, image du film), servie sans le titre dans l'adresse. */
  image?: string;
  /** Le texte de l'indice (accroche, ou distribution — un nom par ligne). */
  text?: string;
  year?: number | null;
  choices: [string, string, string, string];
}

export interface QuizGameData {
  id: string;
  variant: QuizVariant;
  rounds: QuizRound[];
}

export type QuizPhase = "intro" | "question" | "reveal" | "end";

export interface QuizPlayerView {
  id: string;
  name: string;
  score: number;
  streak: number;
  correct: number;
}

export interface QuizView {
  id: string;
  variant: QuizVariant;
  phase: QuizPhase;
  /** La manche en cours (0…), et combien il y en a. */
  round: number;
  total: number;
  /** Début et fin de la phase en cours, en heure de celui qui fait tourner le moteur (le service, à plusieurs). */
  startsAt: number;
  endsAt: number;
  clue: QuizRound | null;
  /** Qui a déjà répondu à cette manche (sans dire quoi). */
  answered: string[];
  /** La bonne réponse — seulement pendant la révélation. */
  answer: number | null;
  /** Ce que chacun a gagné à cette manche — seulement pendant la révélation. */
  gains: Record<string, number> | null;
  players: QuizPlayerView[];
}

export const QUIZ_LIMITS = { maxRounds: 20, minRounds: 3 } as const;
export const INTRO_MS = 3500;
export const REVEAL_MS = 4500;
const BASE_POINTS = 1000;
const FIRST_BONUS = 200;
const STREAK_BONUS = 100;

/** Le temps imparti à une manche : 20 s, et pour « rapide » de 15 s à 6 s au fil des manches. */
export function questionMs(variant: QuizVariant, round: number, total: number): number {
  if (variant !== "rapide") return 20_000;
  const progress = total > 1 ? round / (total - 1) : 0;
  return Math.round(15_000 - progress * 9_000);
}

/** Les points d'une bonne réponse : de 1000 (tout de suite) à 300 (à la dernière seconde), plus les bonus. */
export function pointsFor(elapsedFraction: number, streak: number, first: boolean): number {
  const speed = Math.round(BASE_POINTS * (1 - 0.7 * Math.min(1, Math.max(0, elapsedFraction))));
  return speed + (first ? FIRST_BONUS : 0) + STREAK_BONUS * Math.min(5, Math.max(0, streak - 1));
}

interface Player {
  id: string;
  name: string;
  score: number;
  streak: number;
  bestStreak: number;
  correct: number;
}

export interface QuizFinalPlayer {
  id: string;
  name: string;
  score: number;
  correct: number;
  total: number;
  bestStreak: number;
}

/** Une partie en cours. Le temps est donné à chaque appel ; `tick` fait passer les phases. */
export class QuizGame {
  readonly data: QuizGameData;
  private readonly answers: number[];
  private readonly players = new Map<string, Player>();
  phase: QuizPhase = "intro";
  round = 0;
  startsAt: number;
  endsAt: number;
  private answeredThisRound = new Map<string, number>();
  private gains: Record<string, number> | null = null;
  private firstCorrectDone = false;

  constructor(data: QuizGameData, answers: number[], players: { id: string; name: string }[], now: number) {
    if (answers.length !== data.rounds.length) throw new Error("réponses et manches ne correspondent pas");
    this.data = data;
    this.answers = answers;
    for (const p of players) this.players.set(p.id, { ...p, score: 0, streak: 0, bestStreak: 0, correct: 0 });
    this.startsAt = now;
    this.endsAt = now + INTRO_MS;
  }

  /** Un joueur arrivé en cours de partie joue à partir de la manche suivante. */
  addPlayer(id: string, name: string): void {
    if (!this.players.has(id)) this.players.set(id, { id, name, score: 0, streak: 0, bestStreak: 0, correct: 0 });
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  get playerCount(): number {
    return this.players.size;
  }

  /**
   * Une réponse. Rend `null` si elle ne compte pas (hors du temps de la manche, déjà répondu, joueur inconnu) ;
   * sinon `true`/`false` — que le service garde pour lui jusqu'à la révélation.
   */
  answer(playerId: string, round: number, choice: number, now: number): boolean | null {
    const player = this.players.get(playerId);
    if (!player || this.phase !== "question" || round !== this.round || this.answeredThisRound.has(playerId)) return null;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3 || now > this.endsAt) return null;
    const correct = choice === this.answers[this.round];
    let gain = 0;
    if (correct) {
      player.streak += 1;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
      player.correct += 1;
      const fraction = (now - this.startsAt) / Math.max(1, this.endsAt - this.startsAt);
      gain = pointsFor(fraction, player.streak, !this.firstCorrectDone && this.players.size > 1);
      this.firstCorrectDone = true;
      player.score += gain;
    } else {
      player.streak = 0;
    }
    this.answeredThisRound.set(playerId, gain);
    // Tout le monde a répondu : pas la peine d'attendre la fin du temps.
    if (this.answeredThisRound.size >= this.players.size) this.reveal(now);
    return correct;
  }

  /** Fait passer les phases dont le temps est écoulé. Rend `true` si quelque chose a changé. */
  tick(now: number): boolean {
    let changed = false;
    for (let guard = 0; guard < 4 && now >= this.endsAt && this.phase !== "end"; guard++) {
      changed = true;
      if (this.phase === "intro") this.ask(this.startsAt + INTRO_MS);
      else if (this.phase === "question") this.reveal(this.endsAt);
      else if (this.phase === "reveal") {
        if (this.round + 1 >= this.data.rounds.length) {
          this.phase = "end";
          this.startsAt = this.endsAt;
          this.endsAt = Number.POSITIVE_INFINITY;
        } else {
          this.round += 1;
          this.ask(this.endsAt);
        }
      }
    }
    return changed;
  }

  private ask(at: number): void {
    this.phase = "question";
    this.startsAt = at;
    this.endsAt = at + questionMs(this.data.variant, this.round, this.data.rounds.length);
    this.answeredThisRound = new Map();
    this.gains = null;
    this.firstCorrectDone = false;
  }

  private reveal(at: number): void {
    // Qui n'a pas répondu perd sa série.
    for (const p of this.players.values()) if (!this.answeredThisRound.has(p.id)) p.streak = 0;
    this.gains = Object.fromEntries([...this.players.keys()].map((id) => [id, this.answeredThisRound.get(id) ?? 0]));
    this.phase = "reveal";
    this.startsAt = at;
    this.endsAt = at + REVEAL_MS;
  }

  view(): QuizView {
    const revealing = this.phase === "reveal" || this.phase === "end";
    return {
      id: this.data.id,
      variant: this.data.variant,
      phase: this.phase,
      round: this.round,
      total: this.data.rounds.length,
      startsAt: this.startsAt,
      endsAt: Number.isFinite(this.endsAt) ? this.endsAt : this.startsAt,
      clue: this.phase === "intro" ? null : this.data.rounds[this.round],
      answered: [...this.answeredThisRound.keys()],
      answer: revealing ? this.answers[this.round] : null,
      gains: revealing ? this.gains : null,
      players: [...this.players.values()].map(({ id, name, score, streak, correct }) => ({ id, name, score, streak, correct })).sort((a, b) => b.score - a.score),
    };
  }

  /** Le bilan d'une partie finie : ce que l'application enregistre. */
  final(): QuizFinalPlayer[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, correct: p.correct, total: this.data.rounds.length, bestStreak: p.bestStreak }));
  }
}

/** Une partie reçue d'un client : vérifiée champ par champ avant d'être jouée. `null` si elle ne tient pas. */
export function parseGameData(value: unknown): QuizGameData | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length < 8 || v.id.length > 64) return null;
  if (!QUIZ_VARIANTS.includes(v.variant as QuizVariant)) return null;
  if (!Array.isArray(v.rounds) || v.rounds.length < QUIZ_LIMITS.minRounds || v.rounds.length > QUIZ_LIMITS.maxRounds) return null;
  const rounds: QuizRound[] = [];
  for (const raw of v.rounds) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.kind !== "poster" && r.kind !== "backdrop" && r.kind !== "tagline" && r.kind !== "cast") return null;
    if (!Array.isArray(r.choices) || r.choices.length !== 4 || !r.choices.every((c) => typeof c === "string" && c.length > 0 && c.length <= 120)) return null;
    if (r.image !== undefined && (typeof r.image !== "string" || !r.image.startsWith("/api/quiz/image?") || r.image.length > 600)) return null;
    if (r.text !== undefined && (typeof r.text !== "string" || r.text.length > 400)) return null;
    if (r.year !== undefined && r.year !== null && !Number.isInteger(r.year)) return null;
    rounds.push({ kind: r.kind, choices: r.choices as QuizRound["choices"], ...(r.image ? { image: r.image as string } : {}), ...(r.text ? { text: r.text as string } : {}), ...(r.year ? { year: r.year as number } : {}) });
  }
  return { id: v.id, variant: v.variant as QuizVariant, rounds };
}

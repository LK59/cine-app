import { QuizGame, type QuizGameData, type QuizVariant, type QuizView } from "../../../salons/src/quiz";
import { dispatch } from "../media/commands";
import { onGame, requestRoster, sendGame } from "../net/salons";
import { useStore } from "../state/store";

/**
 * « Devine le film », côté chalet (DECISIONS.md §146, `docs/MULTIJOUEUR.md`).
 *
 * - **Dans un salon** : la partie est préparée par l'application pour **tous** les présents (liste signée par le
 *   service), lancée par le service, qui tient le chronomètre et les scores ; la page ne fait qu'afficher sa vue et
 *   envoyer ses réponses. À la fin, chaque page rend le bilan signé à l'application (enregistré une fois par compte).
 * - **Seul** (pas de salon, ou pas de service) : le même moteur (`salons/src/quiz.ts`) tourne dans la page ; à la fin,
 *   les réponses données repartent à l'application, qui recompte les points elle-même avant d'enregistrer.
 *
 * Lancer une partie arrête le film en cours : la télévision montre le jeu (`game/tv.ts`). On garde la liberté de se
 * déplacer ; on répond avec les touches 1 à 4, ou les boutons au doigt (`ui/QuizHud.tsx`).
 */
const SOLO_ID = "moi";

interface Solo {
  game: QuizGame;
  timer: ReturnType<typeof setInterval>;
  picks: ({ choice: number; at: number } | null)[];
}
let solo: Solo | null = null;

const store = () => useStore.getState();

export type StartFailure = "library" | "roster" | "error" | "busy" | "share";

async function prepare(variant: QuizVariant, roster: string | null): Promise<{ game: QuizGameData; sealed?: string; answers?: number[] } | StartFailure> {
  try {
    const res = await fetch("/api/quiz/partie", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roster ? { variant, roster } : { variant }),
    });
    if (!res.ok) return "error";
    const body = (await res.json()) as { available?: boolean; reason?: StartFailure; game?: QuizGameData; sealed?: string; answers?: number[] };
    if (!body.available || !body.game) return body.reason ?? "error";
    return { game: body.game, sealed: body.sealed, answers: body.answers };
  } catch {
    return "error";
  }
}

/** Lance une partie : dans le salon s'il y en a un, sinon seul. Rend la raison d'un échec, ou `null`. */
export async function startQuiz(variant: QuizVariant): Promise<StartFailure | null> {
  const running = store().quiz;
  if (running && running.view.phase !== "end") return "busy";
  const { net } = store();
  if (net.room && net.status === "online") {
    const roster = await requestRoster();
    if (!roster) return "roster";
    const prepared = await prepare(variant, roster);
    if (typeof prepared === "string") return prepared;
    if (!prepared.sealed) return "error";
    dispatch({ type: "stop" });
    return sendGame({ t: "game.start", game: prepared.game, sealed: prepared.sealed }) ? null : "error";
  }
  const prepared = await prepare(variant, null);
  if (typeof prepared === "string") return prepared;
  if (!prepared.answers) return "error";
  dispatch({ type: "stop" });
  startSolo(prepared.game, prepared.answers);
  return null;
}

function startSolo(data: QuizGameData, answers: number[]): void {
  stopSolo();
  const name = store().net.you?.name ?? "";
  const game = new QuizGame(data, answers, [{ id: SOLO_ID, name }], Date.now());
  solo = { game, picks: data.rounds.map(() => null), timer: setInterval(() => soloTick(), 100) };
  store().setQuiz({ mode: "solo", view: game.view(), you: SOLO_ID, choice: null, recorded: false });
}

function soloTick(): void {
  if (!solo) return;
  const { game } = solo;
  if (!game.tick(Date.now())) return;
  publishSolo();
}

function publishSolo(): void {
  if (!solo) return;
  const view = solo.game.view();
  const previous = store().quiz;
  const sameRound = previous && previous.view.round === view.round && previous.view.phase !== "intro";
  store().setQuiz({ mode: "solo", view, you: SOLO_ID, choice: sameRound ? previous.choice : null, recorded: previous?.recorded ?? false });
  if (view.phase === "end") {
    clearInterval(solo.timer);
    const finished = solo;
    solo = null;
    void record({ gameId: finished.game.data.id, picks: finished.picks });
  }
}

function stopSolo(): void {
  if (!solo) return;
  clearInterval(solo.timer);
  solo = null;
}

/** Répond à la manche en cours (proposition 0 à 3). Une seule réponse par manche. */
export function answerQuiz(choice: number): void {
  const quiz = store().quiz;
  if (!quiz || quiz.view.phase !== "question" || quiz.choice !== null) return;
  store().setQuiz({ ...quiz, choice });
  if (quiz.mode === "solo" && solo) {
    const now = Date.now();
    const { startsAt, endsAt, round } = solo.game.view();
    solo.picks[round] = { choice, at: (now - startsAt) / Math.max(1, endsAt - startsAt) };
    solo.game.answer(SOLO_ID, round, choice, now);
    publishSolo();
    return;
  }
  sendGame({ t: "game.answer", round: quiz.view.round, choice });
}

/** Arrête la partie (seul : tout de suite ; dans un salon : pour tous). */
export function stopQuiz(): void {
  const quiz = store().quiz;
  if (quiz?.mode === "salon" && quiz.view.phase !== "end") sendGame({ t: "game.stop" });
  stopSolo();
  store().setQuiz(null);
}

async function record(body: unknown): Promise<void> {
  try {
    const res = await fetch("/api/quiz/resultat", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return;
    const quiz = store().quiz;
    if (quiz) store().setQuiz({ ...quiz, recorded: true });
  } catch {
    /* un record perdu ne casse rien */
  }
}

// La partie du salon : la vue du service, à chaque changement.
onGame((view: QuizView | null, result: string | undefined) => {
  const { net } = store();
  if (!view) {
    // Plus de partie dans le salon (arrêtée, salon quitté) ; une partie seule continue.
    if (store().quiz?.mode === "salon") store().setQuiz(null);
    return;
  }
  stopSolo();
  const previous = store().quiz;
  const sameRound = previous?.mode === "salon" && previous.view.id === view.id && previous.view.round === view.round && view.phase !== "intro";
  store().setQuiz({ mode: "salon", view, you: net.you?.id ?? "", choice: sameRound ? previous.choice : null, recorded: previous?.view.id === view.id ? previous.recorded : false });
  if (view.phase === "end" && result && !(previous?.view.id === view.id && previous.view.phase === "end")) void record({ result });
});

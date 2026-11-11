import { activeSkip } from "@/lib/playerSkip";
import { useStore, type Playback, type Prompt } from "../state/store";
import { seriesOf } from "./api";
import { dispatch } from "./commands";
import { episodeName, episodesOf, forgetLibrary, nextEpisodeAfter } from "./library";
import { autoAdvances, noteAutoAdvance, STILL_THERE_AFTER } from "./presence";

/**
 * Regarder une série sans quitter le canapé : « Passer l'intro / le récap », puis au générique de fin la carte
 * de l'épisode suivant, avec son décompte.
 *
 * Les règles sont celles du lecteur de l'application (`PlayerControls`, `activeSkip` de `@/lib/playerSkip`, lu
 * tel quel) :
 * - la carte paraît au début du générique de fin (`creditsStart` de la négociation) — ou, faute de repère, à la
 *   dernière seconde : sans lui, l'épisode s'arrêtait sur sa dernière image sans rien proposer ;
 * - le décompte (dix secondes) ne court que pendant la lecture, ou une fois l'épisode fini : mettre en pause
 *   pendant le générique ne doit pas lancer la suite dix secondes plus tard ;
 * - « Regarder le générique » écarte la carte jusqu'à la fin de l'épisode, où elle revient avec son décompte ;
 * - un retour avant le générique remet le décompte à dix ;
 * - au bout de trois enchaînements sans un geste, on demande au lieu de continuer (`presence.ts`).
 *
 * Tout ce qui lance passe par les commandes (`open`), jamais par le `<video>`. Rien ici ne dessine : l'invite est
 * écrite dans l'état (`prompt`), que `ui/Prompts.tsx` affiche.
 */
export const COUNTDOWN_S = 10;
/** Une seconde demande dans l'instant qui suit la première est ignorée : un double appui enjambait un épisode. */
const ADVANCE_GUARD_MS = 1500;

let countdown = COUNTDOWN_S;
let dismissed = false;
let ticker: ReturnType<typeof setInterval> | null = null;
let lastAdvance = Number.NEGATIVE_INFINITY;
/** Le titre et l'épisode suivant pour lesquels l'état de la carte vaut : un autre, et tout repart. */
let cardKey = "";
/** Le titre dont l'épisode suivant a été demandé (une fois par titre). */
let askedFor: string | null = null;

const live = (p: Playback) => p.status === "playing" || p.status === "paused";

/** La fin de l'épisode est-elle atteinte (lecture finie, ou dernière seconde) ? */
const atEnd = (p: Playback) => p.status === "ended" || (live(p) && p.duration > 0 && p.position >= p.duration - 1);

/** Sommes-nous au générique de fin d'un épisode qui a une suite ? */
function inCredits(p: Playback): boolean {
  if (!p.next) return false;
  if (p.status === "ended") return true;
  if (!live(p)) return false;
  const from = p.markers.credits ?? (p.duration > 0 ? p.duration - 1 : null);
  return from !== null && p.position >= from;
}

/** Ce que l'invite doit dire maintenant. */
function decide(p: Playback): Prompt | null {
  const credits = inCredits(p);
  const card = credits && (!dismissed || atEnd(p));
  if (card && p.next) {
    if (countdown === 0 && autoAdvances() >= STILL_THERE_AFTER) return { kind: "stillThere", title: p.next.title };
    return { kind: "next", title: p.next.title, countdown, running: p.status === "ended" || (p.status === "playing" && !p.wantPaused) };
  }
  if (live(p)) {
    const skip = activeSkip(p.position, p.markers.intro, p.markers.recap);
    if (skip) return { kind: "skip", what: skip.kind, end: skip.end };
  }
  return null;
}

function refresh(): void {
  const state = useStore.getState();
  const p = state.playback;
  const key = `${p.itemId ?? ""}:${p.next?.itemId ?? ""}`;
  if (key !== cardKey) {
    cardKey = key;
    dismissed = false;
    countdown = COUNTDOWN_S;
  }
  let prompt = decide(p);
  // La carte s'en va (retour avant le générique, autre titre) : le décompte repart de dix la prochaine fois.
  if (prompt?.kind !== "next" && prompt?.kind !== "stillThere") countdown = COUNTDOWN_S;
  // Le décompte arrivé à zéro lance la suite — sauf quand c'est la question qui s'affiche.
  if (prompt?.kind === "next" && prompt.countdown === 0 && prompt.running) {
    if (performance.now() - lastAdvance >= ADVANCE_GUARD_MS) {
      noteAutoAdvance();
      advance(true);
      return;
    }
  }
  const running = prompt?.kind === "next" && prompt.running && prompt.countdown > 0;
  if (running && !ticker) {
    ticker = setInterval(() => {
      countdown = Math.max(0, countdown - 1);
      refresh();
    }, 1000);
  } else if (!running && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  // Recalculé après le dernier tic (le décompte a pu tomber à zéro sans relancer).
  prompt = decide(useStore.getState().playback);
  state.setPrompt(prompt);
}

/** Lance l'épisode suivant. `auto` : par la fin du décompte, sans geste du visiteur. */
function advance(auto: boolean): boolean {
  const next = useStore.getState().playback.next;
  const now = performance.now();
  if (!next || now - lastAdvance < ADVANCE_GUARD_MS) return false;
  lastAdvance = now;
  // « Reprendre » aura changé après cette lecture (comme `launch`).
  forgetLibrary();
  dispatch({ type: "open", item: { id: next.itemId, title: next.title }, from: next.from, ...(auto ? { auto: true } : {}) });
  return true;
}

/** Cherche l'épisode qui suit le titre en cours, une fois par titre ; rien pour un film. */
function learnNext(itemId: string): void {
  askedFor = itemId;
  void (async () => {
    const series = await seriesOf(itemId).catch(() => null);
    if (!series || useStore.getState().playback.itemId !== itemId) return;
    const data = await episodesOf(series).catch(() => null);
    const p = useStore.getState().playback;
    if (!data || p.itemId !== itemId) return;
    const next = nextEpisodeAfter(data.episodes, itemId);
    if (!next) return;
    // Le nom de la série : ce qui précède « — » dans celui de l'épisode en cours (« Série — S01E02 · Titre »).
    const current = p.title ?? "";
    const dash = current.indexOf(" — ");
    const seriesName = dash > 0 ? current.slice(0, dash) : current;
    // Où le reprendre : sa position si Jellyfin en garde une, sinon le début (`episodeResumeAt` de l'application).
    useStore.getState().setPlayback({ next: { itemId: next.itemId, title: episodeName(seriesName, next), from: next.resume > 0 ? next.resume : 0 } });
  })();
}

/** L'invite acceptée (touche Entrée, ou le bouton) : passer l'intro, ou lancer l'épisode suivant tout de suite. */
export function acceptPrompt(): void {
  const prompt = useStore.getState().prompt;
  if (!prompt) return;
  if (prompt.kind === "skip") dispatch({ type: "seek", to: prompt.end });
  else advance(false);
}

/** « Regarder le générique » : la carte s'efface jusqu'à la fin de l'épisode. */
export function dismissPrompt(): void {
  const prompt = useStore.getState().prompt;
  if (prompt?.kind !== "next" && prompt?.kind !== "stillThere") return;
  dismissed = true;
  refresh();
}

let started = false;
/** Branche le contrôleur (une fois) : il suit l'état de lecture. */
export function startUpNext(): void {
  if (started) return;
  started = true;
  useStore.subscribe((state, previous) => {
    const now = state.playback;
    const before = previous.playback;
    if (now === before) return;
    if (now.itemId && now.itemId !== askedFor && now.status !== "idle") learnNext(now.itemId);
    if (!now.itemId) askedFor = null;
    if (now.position !== before.position || now.status !== before.status || now.wantPaused !== before.wantPaused || now.next !== before.next || now.markers !== before.markers || now.duration !== before.duration || now.itemId !== before.itemId) refresh();
  });
}

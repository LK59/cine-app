/**
 * La minuterie de veille : s'endormir devant un film sans qu'il joue jusqu'au matin.
 *
 * Deux sortes de minuterie. Une **durée** (15, 30, 60, 90 min) : un temps de film, compté seulement
 * pendant la lecture — une pause ne le consomme pas, sans quoi aller chercher un verre d'eau
 * raccourcissait la soirée. Dans ses cinq dernières secondes le son descend, puis le film se met en
 * pause, sans fermer le lecteur : on se réveille sur l'image où l'on s'est endormi. Et **la fin de
 * l'épisode** : l'épisode va à son terme, puis rien — ni décompte, ni épisode suivant.
 *
 * L'état vit ici, hors de React et au-dessus des lecteurs, et c'est tout l'intérêt d'une durée :
 * l'hôte natif est remonté à chaque épisode et à chaque ouverture (sa `key` porte `itemId`), le
 * pipeline à chaque reconstruction. Une minuterie tenue dans l'un d'eux serait repartie de zéro au
 * premier épisode enchaîné — précisément le moment où personne n'est plus là pour la relancer.
 * `PlaybackProvider` l'efface à la fermeture du lecteur et à chaque nouvelle ouverture ; elle n'est
 * gardée nulle part sur l'appareil : une minuterie d'hier soir n'a rien à faire dans le film de ce soir.
 *
 * Les règles sont des fonctions pures, testées sans navigateur (`sleepTimer.test.ts`) ; le magasin ne
 * fait que les appliquer et prévenir. Le moteur — l'horloge, le son, la pause — est `useSleepTimer`,
 * monté par chacun des deux lecteurs. DECISIONS.md §43.
 */

/** Ce que le spectateur choisit. Des chaînes : c'est aussi ce que le journal écrit. */
export type SleepMode = "off" | "15" | "30" | "60" | "90" | "episode";

/** Les durées proposées, dans l'ordre du menu. */
export const SLEEP_DURATIONS = ["15", "30", "60", "90"] as const satisfies readonly SleepMode[];

/** À combien de la fin la ligne « Arrêt dans 30 s · Continuer » paraît. */
export const SLEEP_WARNING_MS = 30_000;
/** La descente du son, prise sur les dernières secondes de la durée. */
export const SLEEP_FADE_MS = 5_000;

export interface SleepTimerState {
  mode: SleepMode;
  /** Le temps de lecture qui reste, pour une durée ; `null` sinon. */
  remainingMs: number | null;
  /**
   * La minuterie qui a mis le film en pause dans cette séance, s'il y en a eu une — pour la ligne
   * `stop`, écrite parfois longtemps après : la minuterie, elle, est retombée à « off » en se déclenchant.
   */
  fired: SleepMode | null;
}

export const SLEEP_OFF: SleepTimerState = { mode: "off", remainingMs: null, fired: null };

const isDuration = (mode: SleepMode): boolean => mode !== "off" && mode !== "episode";

function durationMs(mode: SleepMode): number | null {
  return isDuration(mode) ? Number(mode) * 60_000 : null;
}

/** Le choix du menu. Rechoisir la même durée la relance en entier. */
export function chooseSleepTimer(state: SleepTimerState, mode: SleepMode): SleepTimerState {
  return { mode, remainingMs: durationMs(mode), fired: state.fired };
}

/**
 * Le temps passe. Il ne compte que pendant la lecture : une pause, une attente de reconstruction,
 * un film fini ne consomment rien.
 */
export function tickSleepTimer(state: SleepTimerState, elapsedMs: number, playing: boolean): SleepTimerState {
  if (state.remainingMs === null || !playing || !(elapsedMs > 0)) return state;
  return { ...state, remainingMs: Math.max(0, state.remainingMs - elapsedMs) };
}

/** Le volume à appliquer, en fraction de celui du spectateur : 1, puis la descente des dernières secondes. */
export function sleepVolumeFactor(state: SleepTimerState): number {
  if (state.remainingMs === null || state.remainingMs >= SLEEP_FADE_MS) return 1;
  return state.remainingMs / SLEEP_FADE_MS;
}

/** La durée est écoulée : c'est le moment de mettre en pause. */
export function sleepTimerDue(state: SleepTimerState): boolean {
  return state.remainingMs !== null && state.remainingMs <= 0;
}

/** Les secondes affichées par « Arrêt dans 30 s », ou `null` hors des trente dernières secondes. */
export function sleepWarningSeconds(state: SleepTimerState): number | null {
  if (state.remainingMs === null || state.remainingMs > SLEEP_WARNING_MS || state.remainingMs <= 0) return null;
  return Math.ceil(state.remainingMs / 1000);
}

/** Les minutes qui restent, arrondies au-dessus — le libellé du menu, qui ne change qu'une fois par minute. */
export function sleepRemainingMinutes(state: SleepTimerState): number | null {
  return state.remainingMs === null ? null : Math.max(1, Math.ceil(state.remainingMs / 60_000));
}

/** « Continuer » : la même durée, repartie en entier. */
export function continueSleepTimer(state: SleepTimerState): SleepTimerState {
  return chooseSleepTimer(state, state.mode);
}

/** La minuterie a mis le film en pause : elle retombe, et la séance se souvient qu'elle l'a fait. */
export function sleepTimerFired(state: SleepTimerState): SleepTimerState {
  return { mode: "off", remainingMs: null, fired: state.mode };
}

/**
 * L'épisode suivant ne s'enchaîne pas : « Fin de l'épisode » est choisi.
 *
 * Lue par les commandes (ni carte ni décompte) et par les deux lecteurs à la fin du fichier (l'écran
 * de fin du lecteur natif, le lecteur serveur qui reste ouvert au lieu d'enchaîner).
 */
export function blocksAutoAdvance(state: SleepTimerState): boolean {
  return state.mode === "episode";
}

/**
 * Ce que la ligne `stop` (et la ligne de mise en veille) porte : la minuterie choisie, ou celle qui
 * s'est déclenchée. Rien quand il n'y en a jamais eu — la plupart des séances.
 */
export function sleepTimerLogFields(state: SleepTimerState): { sleepTimer?: SleepMode } {
  const mode = state.mode !== "off" ? state.mode : state.fired;
  return mode ? { sleepTimer: mode } : {};
}

// --- Le magasin -------------------------------------------------------------------------------

let state: SleepTimerState = SLEEP_OFF;
/**
 * Le volume du spectateur au début de la descente — gardé ici, hors de l'élément, parce qu'un
 * épisode enchaîné pendant ces cinq secondes change d'élément. Tant qu'il est posé, le volume de
 * l'élément n'est pas celui du spectateur, et les commandes ne le retiennent pas (`sleepFading`).
 */
let fadeBase: number | null = null;
const listeners = new Set<() => void>();

function set(next: SleepTimerState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

export const sleepTimerStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): SleepTimerState => state,
  choose: (mode: SleepMode): void => set(chooseSleepTimer(state, mode)),
  continue: (): void => set(continueSleepTimer(state)),
  tick: (elapsedMs: number, playing: boolean): SleepTimerState => {
    set(tickSleepTimer(state, elapsedMs, playing));
    return state;
  },
  fired: (): void => set(sleepTimerFired(state)),
  /** Fermeture du lecteur, ou nouvelle ouverture : plus de minuterie, plus de souvenir. */
  clear: (): void => {
    fadeBase = null;
    set(SLEEP_OFF);
  },
  fadeBase: (): number | null => fadeBase,
  setFadeBase: (volume: number | null): void => {
    fadeBase = volume;
  },
};

/** Le son est en train de descendre : le volume de l'élément n'est pas celui que le spectateur a choisi. */
export function sleepFading(): boolean {
  return fadeBase !== null;
}

// Des instantanés réduits à des valeurs simples : le magasin prévient à chaque battement, et
// `useSyncExternalStore` ne redessine que si la valeur lue a changé — le mode, une fois par choix ;
// les minutes, une fois par minute ; l'avertissement, une fois par seconde pendant trente secondes.
export const sleepModeSnapshot = (): SleepMode => state.mode;
export const sleepMinutesSnapshot = (): number | null => sleepRemainingMinutes(state);
export const sleepWarningSnapshot = (): number | null => sleepWarningSeconds(state);
export const sleepBlocksAdvanceSnapshot = (): boolean => blocksAutoAdvance(state);
export const sleepServerSnapshot = (): SleepMode => "off";
export const sleepNullServerSnapshot = (): null => null;
export const sleepFalseServerSnapshot = (): boolean => false;

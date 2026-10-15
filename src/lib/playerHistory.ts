"use client";

import { useEffect, useRef } from "react";

/**
 * Le lecteur plein écran a son entrée d'historique : Retour le ferme (DECISIONS.md, « Retour ferme
 * le lecteur »).
 *
 * Le geste retour d'iOS, le bouton Retour d'Android et la touche Précédent du navigateur fermaient
 * la fiche *cachée sous* le film, qui continuait de jouer ; le Retour suivant quittait l'application
 * en plein film (passe de nuit du 15/10/2026, LECTEUR-11). Louis a tranché le 15/10 au matin :
 * Retour ferme le lecteur, exactement comme la croix.
 *
 * - **À l'ouverture plein écran** (`play`, `expand` depuis le mini-lecteur), une entrée est empilée :
 *   la même adresse (le hash de la fiche ne bouge pas, `cinemaRoute` ne voit rien changer), son
 *   `history.state` recopié — Next et la pile des fiches y lisent leurs clés —, plus un jeton à nous
 *   (`PLAYER_HISTORY_KEY`). Un lecteur déjà plein écran qui en ouvre un autre (la suite d'une saga)
 *   réécrit cette entrée au lieu d'en empiler une seconde ; l'épisode suivant n'y touche pas.
 * - **Retour** la quitte : `popstate` voit que l'entrée courante n'est plus la nôtre et demande la
 *   fermeture au lecteur monté (`usePlayerBackClose`) — sa croix, avec son bilan, l'arrêt chez
 *   Jellyfin, son fondu et `refreshAfterPlayback`. La fiche dessous reste telle quelle.
 * - **La croix, la fin, la réduction** rendent l'entrée (`releasePlayerEntry`) : un `history.back()`
 *   que l'écouteur reconnaît comme le nôtre, pour que le Retour suivant ferme la fiche et non
 *   l'application. Le mini-lecteur n'a pas d'entrée : il vit sous la navigation.
 * - **Une page rechargée** garde son `history.state`. Rechargée pour rouvrir le lecteur (WebKit :
 *   changement de piste, relais natif → serveur), l'entrée est **reprise** (`adopt`), jamais doublée ;
 *   rechargée autrement, l'entrée n'a plus de lecteur : son jeton est effacé (`installPlayerHistory`).
 * - **Une entrée orpheline** (un titre ouvert depuis l'écran de fin, empilé au-dessus d'elle ; un
 *   Suivant du navigateur) est sautée dès qu'on y arrive.
 */

export const PLAYER_HISTORY_KEY = "cinePlayer";

/** Un jeton par chargement de page : un jeton d'avant un rechargement n'est jamais pris pour le nôtre. */
const PAGE = Math.random().toString(36).slice(2, 10);

/** Le jeton de l'entrée que le lecteur occupe — `null` quand il n'en a pas (fermé, réduit). */
let live: string | null = null;
/** Un `history.back()` parti d'ici : son `popstate` n'est pas un Retour du spectateur. */
let consuming = 0;
let consumeTimer: ReturnType<typeof setTimeout> | null = null;

type Closer = () => void;
/** Les fermetures des lecteurs montés, la plus récente en dernier. */
const closers: Closer[] = [];

function stateOf(): Record<string, unknown> {
  const s = typeof window === "undefined" ? null : window.history.state;
  return s && typeof s === "object" ? (s as Record<string, unknown>) : {};
}

function tokenHere(): unknown {
  return stateOf()[PLAYER_HISTORY_KEY];
}

/** L'état d'une entrée, sans notre jeton — pour `cinemaRoute`, qui empile une fiche par-dessus. */
export function withoutPlayerEntry(state: Record<string, unknown>): Record<string, unknown> {
  if (!(PLAYER_HISTORY_KEY in state)) return state;
  const copy = { ...state };
  delete copy[PLAYER_HISTORY_KEY];
  return copy;
}

function write(token: string, mode: "push" | "replace") {
  const state = { ...stateOf(), [PLAYER_HISTORY_KEY]: token };
  const url = window.location.href;
  if (mode === "push") window.history.pushState(state, "", url);
  else window.history.replaceState(state, "", url);
  live = token;
}

/**
 * Le lecteur passe en plein écran : son entrée. Réécrite si l'entrée courante est déjà une entrée de
 * lecteur (un film qui en remplace un autre, une page rechargée pour le rouvrir) ; empilée sinon.
 */
export function holdPlayerEntry(openId: number | undefined, { adopt = false }: { adopt?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  try {
    const token = `${PAGE}:${openId ?? 0}`;
    const here = tokenHere();
    if (here === token) {
      live = token;
      return;
    }
    // Déjà une entrée de lecteur sous nos pieds : la nôtre (un film en remplace un autre), ou celle
    // qu'un rechargement voulu a gardée (`adopt`). Jamais deux entrées pour un seul lecteur.
    if (typeof here === "string" && (here === live || adopt)) write(token, "replace");
    else write(token, "push");
  } catch {
    // L'historique refusé (rare : quota de `pushState`) — le lecteur s'ouvre quand même, sans Retour.
    live = null;
  }
}

/** La croix, la fin, la réduction : l'entrée est rendue, si elle est encore au-dessus de la pile. */
export function releasePlayerEntry(): void {
  if (typeof window === "undefined" || live === null) return;
  const token = live;
  live = null;
  if (tokenHere() === token) consumeTop();
}

function consumeTop() {
  consuming += 1;
  if (consumeTimer) clearTimeout(consumeTimer);
  // Une ceinture : `popstate` suit toujours un `back()` qui avait quelque chose derrière lui.
  consumeTimer = setTimeout(() => {
    consuming = 0;
    consumeTimer = null;
  }, 600);
  try {
    window.history.back();
  } catch {
    consuming = 0;
  }
}

function onPopState(fallbackClose: () => void) {
  if (consuming > 0) {
    consuming -= 1;
    return;
  }
  const here = tokenHere();
  if (live !== null && here !== live) {
    // Retour (ou un saut de plusieurs crans) : l'entrée du lecteur est quittée.
    live = null;
    const closer = closers[closers.length - 1];
    try {
      if (closer) closer();
      else fallbackClose();
    } catch {
      fallbackClose();
    }
    return;
  }
  // Arrivé sur une entrée de lecteur qui n'a plus de lecteur : sautée.
  if (live === null && typeof here === "string") consumeTop();
}

/**
 * Branché une fois par `PlaybackProvider`. `fallbackClose` ferme la séance quand aucun lecteur n'est
 * encore monté pour le faire lui-même. `reloading` : la page a été rechargée pour rouvrir le lecteur
 * — son entrée sera reprise, sinon elle n'a plus de lecteur et son jeton est effacé.
 */
export function installPlayerHistory(fallbackClose: () => void, reloading: boolean): () => void {
  if (typeof window === "undefined") return () => {};
  if (!reloading && typeof tokenHere() === "string" && tokenHere() !== live) {
    try {
      window.history.replaceState(withoutPlayerEntry(stateOf()), "", window.location.href);
    } catch {
      /* rien à effacer de plus */
    }
  }
  const listener = () => onPopState(fallbackClose);
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

/**
 * Le lecteur monté s'inscrit : Retour appellera sa fermeture — la même que sa croix. La dernière
 * version de la fonction est lue au moment du Retour.
 */
export function usePlayerBackClose(close: () => void): void {
  const ref = useRef(close);
  useEffect(() => {
    ref.current = close;
  }, [close]);
  useEffect(() => {
    const closer: Closer = () => ref.current();
    closers.push(closer);
    return () => {
      const i = closers.lastIndexOf(closer);
      if (i >= 0) closers.splice(i, 1);
    };
  }, []);
}

/** Pour les tests : l'état du module remis à zéro. */
export function __resetPlayerHistoryForTests(): void {
  live = null;
  consuming = 0;
  if (consumeTimer) clearTimeout(consumeTimer);
  consumeTimer = null;
  closers.length = 0;
}

/** Pour les tests : le jeton tenu par le lecteur. */
export function __livePlayerEntry(): string | null {
  return live;
}

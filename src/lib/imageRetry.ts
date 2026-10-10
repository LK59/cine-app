/**
 * Les images qui échouent retentent, au lieu d'abandonner pour toujours (10/10/2026).
 *
 * Chaque image du cinéma — affiche, logo, bannière, fond de la bannière d'accueil, logo de
 * l'ouverture de lecture — se marquait « en échec » au premier `onError` et montrait son repli
 * (carré gris, titre écrit, fond sombre) jusqu'à ce que l'élément soit remonté, au pire jusqu'au
 * redémarrage de l'appli. Sur un réseau instable (l'itinérance), un échec passager laissait ainsi
 * des affiches grises et des logos en texte toute la soirée.
 *
 * Un seul registre pour toutes, que `useImageRetry` alimente, et non une minuterie par image :
 * - après un échec, de nouveaux essais à ~2 s, ~6 s puis ~15 s (au hasard de ±20 %, pour qu'une
 *   grille entière ne revienne pas au même instant), puis plus rien ;
 * - au retour du réseau (`online`) et au retour sur l'appli (`visibilitychange`), toutes les images
 *   en échec réessaient tout de suite, et leur échelle repart du début — deux écouteurs pour toute
 *   l'appli, pas deux par image ;
 * - jamais plus de `MAX_CONCURRENT_RETRIES` essais à la fois, les images à l'écran d'abord : au
 *   retour du réseau, une grille en compte des centaines ;
 * - hors ligne (`navigator.onLine` faux), rien n'est tenté avant `online` ;
 * - pendant un film en plein écran, rien n'est tenté pour ce qu'il recouvre — seulement les images
 *   du lecteur lui-même (`player`).
 *
 * Un essai redemande exactement la même adresse : une réponse en erreur n'est pas gardée en cache
 * par le navigateur, et une adresse inchangée garde la clé de cache de ses chargements réussis
 * (les visuels Jellyfin balisés sont immuables, ceux de TMDB gardés un an).
 */

import { isWatchingFullScreen } from "@/lib/playbackBusy";

/** Les délais des nouveaux essais, après le premier échec puis après chacun. */
export const RETRY_DELAYS_MS = [2000, 6000, 15000] as const;

/** Combien d'essais en vol à la fois, au plus. */
export const MAX_CONCURRENT_RETRIES = 6;

/** Une image différée par un film est relue à ce rythme, le temps qu'il se termine. */
const DEFERRED_RECHECK_MS = 3000;

type State = "waiting" | "due" | "running" | "stopped";

export type RetryEntry = {
  /** Relance le chargement — l'appelant dira comment il s'est terminé par `settleRetry`. */
  retry: () => void;
  /** Une image du lecteur : tentée même pendant un film. */
  player?: boolean;
  /** À l'écran, d'après `IntersectionObserver` — prioritaire. Sans élément connu : vrai. */
  visible?: boolean;
};

type Tracked = RetryEntry & {
  attempt: number;
  state: State;
  timer: ReturnType<typeof setTimeout> | null;
};

const tracked = new Map<RetryEntry, Tracked>();
let running = 0;
let installed = false;
let deferredTimer: ReturnType<typeof setTimeout> | null = null;

/** Le hasard est injecté en test ; ±20 % autour du délai. */
let random = Math.random;
export function setRetryRandomForTests(fn: () => number): void {
  random = fn;
}

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("online", retryAllNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retryAllNow();
  });
}

/** Le réseau revient, ou l'appli : tout ce qui est en échec réessaie, l'échelle repart de zéro. */
export function retryAllNow(): void {
  for (const t of tracked.values()) {
    if (t.state === "running" || t.state === "due") continue;
    if (t.timer !== null) clearTimeout(t.timer);
    t.timer = null;
    t.attempt = 0;
    t.state = "due";
  }
  // Toutes marquées d'abord, servies ensuite : sinon les premières inscrites partaient avant que
  // les images à l'écran ne soient seulement dans la file.
  pump();
}

function markDue(t: Tracked): void {
  t.state = "due";
  pump();
}

function schedule(t: Tracked): void {
  if (t.timer !== null) clearTimeout(t.timer);
  t.timer = null;
  if (t.attempt >= RETRY_DELAYS_MS.length || !online()) {
    // Au bout de l'échelle, ou hors ligne : on attend le retour du réseau ou de l'appli.
    t.state = "stopped";
    return;
  }
  const base = RETRY_DELAYS_MS[t.attempt];
  t.attempt += 1;
  t.state = "waiting";
  t.timer = setTimeout(() => {
    t.timer = null;
    markDue(t);
  }, base * (0.8 + random() * 0.4));
}

function pump(): void {
  const filmOnScreen = isWatchingFullScreen();
  let deferred = false;
  while (running < MAX_CONCURRENT_RETRIES) {
    let pick: Tracked | null = null;
    for (const t of tracked.values()) {
      if (t.state !== "due") continue;
      if (!online()) continue;
      if (filmOnScreen && !t.player) {
        deferred = true;
        continue;
      }
      if (!pick || (t.visible !== false && pick.visible === false)) pick = t;
      if (pick.visible !== false) break;
    }
    if (!pick) break;
    pick.state = "running";
    running += 1;
    try {
      pick.retry();
    } catch {
      settleRetry(pick, false);
    }
  }
  if (deferred && deferredTimer === null) {
    deferredTimer = setTimeout(() => {
      deferredTimer = null;
      pump();
    }, DEFERRED_RECHECK_MS);
  }
}

/** Une image vient d'échouer (premier échec ou essai). */
export function reportImageFailure(entry: RetryEntry): void {
  install();
  let t = tracked.get(entry);
  if (!t) {
    t = Object.assign(entry as Tracked, { attempt: 0, state: "waiting" as State, timer: null });
    tracked.set(entry, t);
  }
  if (t.state === "running") running = Math.max(0, running - 1);
  schedule(t);
  pump();
}

/** Un essai s'est terminé ; réussi, l'image sort du registre. */
export function settleRetry(entry: RetryEntry, ok: boolean): void {
  const t = tracked.get(entry);
  if (!t) return;
  if (ok) {
    // `forgetImage` rend sa place à un essai en vol — une seule fois.
    forgetImage(entry);
    pump();
    return;
  }
  reportImageFailure(entry);
}

/** L'image n'existe plus (démontée, autre adresse) : plus rien à tenter pour elle. */
export function forgetImage(entry: RetryEntry): void {
  const t = tracked.get(entry);
  if (!t) return;
  if (t.timer !== null) clearTimeout(t.timer);
  if (t.state === "running") running = Math.max(0, running - 1);
  tracked.delete(entry);
}

/** Pour les tests : l'état du registre. */
export function imageRetryStateForTests(): { tracked: number; running: number; states: State[] } {
  return { tracked: tracked.size, running, states: [...tracked.values()].map((t) => t.state) };
}

export function resetImageRetryForTests(): void {
  for (const t of tracked.values()) if (t.timer !== null) clearTimeout(t.timer);
  tracked.clear();
  running = 0;
  if (deferredTimer !== null) clearTimeout(deferredTimer);
  deferredTimer = null;
  random = Math.random;
}

/**
 * Un essai « en sonde » : l'adresse rechargée hors du document, pour les images dont le repli
 * remplace l'élément (logo → titre écrit, bannière → fond uni). Réussie, l'image est en cache et
 * l'élément qui la remplace s'affiche aussitôt.
 */
export function probeImage(src: string, done: (ok: boolean) => void): void {
  if (typeof Image === "undefined") {
    done(false);
    return;
  }
  const img = new Image();
  img.decoding = "async";
  img.onload = () => done(true);
  img.onerror = () => done(false);
  img.src = src;
}

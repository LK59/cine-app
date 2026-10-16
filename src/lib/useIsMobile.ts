"use client";

import { useSyncExternalStore } from "react";
import { isFireTv } from "@/lib/fireTv";
import { ipadSimulatorOn } from "@/lib/ipadSimulator";

// Tailwind's own md breakpoint — the same line the rest of the app's responsive classes switch
// on, so "mobile" here means exactly what it means everywhere else in the UI.
//
// Plus a second clause for the case width alone gets wrong: a phone turned sideways is ~844px
// wide and would fall through to the desktop layout, which assumes a tall window (a hero pane
// stacked over the rows). Short AND coarse-pointer keeps that to touch devices — a 13" laptop is
// ~800px tall with a mouse, so it stays on the desktop UI exactly as before.
const MOBILE_QUERY = "(max-width: 767px), (max-height: 500px) and (pointer: coarse)";

// A viewport with almost no vertical room — a phone in landscape, essentially. Layouts that lead
// with a tall piece of key art use it to lay that art out sideways instead.
const SHORT_QUERY = "(max-height: 500px)";

const subscribers = new Map<string, (onChange: () => void) => () => void>();

// useSyncExternalStore wants a stable subscribe function per query — one built fresh each render
// would tear down and re-add the listener every time.
function subscriberFor(query: string): (onChange: () => void) => () => void {
  let fn = subscribers.get(query);
  if (!fn) {
    fn = (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    };
    subscribers.set(query, fn);
  }
  return fn;
}

// useSyncExternalStore rather than the usual useState+useEffect media-query pattern: that one
// needs a setState in the effect body to seed the initial value (which this project's
// react-hooks/set-state-in-effect rule rejects) and renders one frame with a guessed value.
// The server snapshot returns false — desktop is the safe assumption for markup that only exists
// to be hydrated, and the client corrects it on the very first client render.
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscriberFor(query),
    () => window.matchMedia(query).matches,
    () => false
  );
}

/**
 * L'interface tactile (celle du téléphone) ou l'interface ordinateur — la décision unique
 * (16/10/2026). Le nom est resté `useIsMobile` : six écrans le lisent, et « mobile » veut dire
 * désormais « l'interface tactile », plus seulement « un écran étroit ».
 *
 * L'interface ordinateur supposait une souris : une bannière qui suit le survol, une navigation aux
 * flèches. Sur iPad, Safari simule un survol à chaque toucher, la bannière change, et il avale
 * parfois le clic (les touchers perdus de Lucas) ; Louis, au simulateur, l'a jugée inadaptée au
 * doigt. Un appareil touché (`hover: none` + `pointer: coarse`) reçoit donc l'interface tactile,
 * quelle que soit sa taille — elle s'élargit d'elle-même (`tablet:` dans `globals.css`).
 *
 * Dans l'ordre :
 *  1. un écran étroit — un téléphone, une fenêtre réduite : toujours l'interface tactile ;
 *  2. le choix de l'appareil (Compte → Interface), là où il est proposé (`canChooseInterface`) ;
 *  3. sinon, automatique : tactile si l'appareil est touché, sauf une Fire TV (la télécommande,
 *     aux flèches, est faite pour l'interface ordinateur).
 * Le pointeur est lu une fois au chargement : un clavier à pavé branché sur l'iPad ne fait pas
 * basculer l'écran sous les doigts ; changer le choix recharge la page.
 */
export type InterfaceChoice = "auto" | "touch" | "desktop";
const INTERFACE_KEY = "cine:interface";

export function interfaceChoice(): InterfaceChoice {
  try {
    const v = window.localStorage.getItem(INTERFACE_KEY);
    return v === "touch" || v === "desktop" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function setInterfaceChoice(choice: InterfaceChoice): void {
  try {
    if (choice === "auto") window.localStorage.removeItem(INTERFACE_KEY);
    else window.localStorage.setItem(INTERFACE_KEY, choice);
  } catch {
    // Stockage refusé : rien ne serait gardé au rechargement.
    return;
  }
  window.location.reload();
}

let touchAtLoad: boolean | null = null;
function touchDevice(): boolean {
  touchAtLoad ??= window.matchMedia(TOUCH_QUERY).matches && !isFireTv();
  return touchAtLoad;
}

/**
 * Le choix n'a de sens que là où les deux interfaces en ont : un appareil qu'on peut toucher et
 * dont l'écran est large — iPad, tablette, ordinateur à écran tactile. Ni un téléphone (l'interface
 * ordinateur y est illisible), ni un ordinateur sans écran tactile (l'interface tactile y perdrait
 * ses gestes), ni une télévision. Le simulateur d'iPad, sur un iPhone, le propose aussi.
 */
export function canChooseInterface(): boolean {
  if (typeof window.matchMedia !== "function" || isFireTv()) return false;
  if (ipadSimulatorOn()) return true;
  const touchable = window.matchMedia("(any-pointer: coarse)").matches;
  return touchable && Math.min(window.screen.width, window.screen.height) >= 600;
}

function touchInterface(narrow: boolean): boolean {
  if (narrow) return true;
  const choice = canChooseInterface() ? interfaceChoice() : "auto";
  if (choice !== "auto") return choice === "touch";
  return touchDevice();
}

/** Pour les tests : oublier le pointeur lu au chargement. */
export function resetInterfaceForTests(): void {
  touchAtLoad = null;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscriberFor(MOBILE_QUERY),
    () => touchInterface(window.matchMedia(MOBILE_QUERY).matches),
    () => false
  );
}

export function useInterfaceChoosable(): boolean {
  return useSyncExternalStore(noSubscribe, canChooseInterface, () => false);
}
const noSubscribe = () => () => {};

/**
 * L'interface tactile sur un grand écran : iPad, tablette (16/10/2026). Les mises en page du
 * téléphone s'y élargissent — la bannière prend l'image de fond, la fiche reste une carte de
 * lecture. Même requête que la variante CSS `tablet:` (globals.css). Ne dit rien de l'interface :
 * à lire sous `useIsMobile`.
 */
const TABLET_QUERY = "(min-width: 768px) and (min-height: 501px)";

export function useIsTablet(): boolean {
  return useMediaQuery(TABLET_QUERY);
}

export function useIsShortViewport(): boolean {
  return useMediaQuery(SHORT_QUERY);
}

/**
 * Un appareil qu'on touche, et non qu'on pointe.
 *
 * Distinct de `useIsMobile` : une tablette a la **taille** d'un bureau et le **pointeur** d'un
 * téléphone. Elle recevait la mise en page large, sans aucun des gestes qu'elle suppose ; depuis le
 * 16/10/2026 elle reçoit l'interface tactile (`useIsMobile`), et ce qui suit ne vaut plus que pour
 * l'interface ordinateur choisie sur un appareil touché (Compte → Interface).
 *
 * C'est la règle qui manquait : la mise en page suit la taille, l'interaction suit le pointeur.
 * Relevé le 20/09/2026 en auditant ce que l'écran bureau attend d'une souris — une bannière qui
 * suit le survol, des fiches qu'on ferme par une croix, et rien qui réponde au doigt.
 *
 * `hover: none` plutôt que `pointer: coarse` seul : un écran tactile de portable a les deux, et
 * c'est bien l'absence de survol qui décide ici, pas la grosseur du pointeur.
 */
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

export function useIsTouch(): boolean {
  return useMediaQuery(TOUCH_QUERY);
}

import { device, emit, motion, resetMotion, type Intent, zoomBy } from "./intents";

/**
 * Le clavier et la souris : le seul périphérique d'aujourd'hui.
 *
 * - **Se déplacer** : par défaut les quatre touches sont lues par leur **position** (`event.code`) — la
 *   croix sous la main gauche, quelles que soient les lettres gravées dessus : Z-Q-S-D sur un clavier
 *   AZERTY, W-A-S-D en QWERTY comme en QWERTZ. Rien à régler. Le réglage « Clavier » permet de forcer
 *   une disposition : les touches sont alors lues par leur **lettre** (Z Q S D, ou W A S D) — pour un
 *   clavier dont les positions ne disent pas la vérité (touches réaffectées, disposition exotique).
 * - Espace, les flèches, Entrée et Retour arrière sont lus par leur position.
 * - **Les autres touches** (E, F, M) sont des initiales : elles sont lues par leur **lettre**, pour que
 *   la touche gravée « M » soit bien celle qui coupe le son (en AZERTY elle n'est pas à la place du M
 *   américain). Si la lettre n'existe pas sur ce clavier (cyrillique, grec…), la position sert de repli.
 * - Les libellés affichés suivent la disposition réelle : demandée au navigateur quand il sait la dire
 *   (Chromium), sinon devinée à la langue puis corrigée à la première touche de déplacement pressée.
 * - Le regard : la souris, pointeur verrouillé. Échap ne parvient pas à la page tant qu'il l'est — le
 *   navigateur le garde pour rendre le pointeur. C'est donc la **perte du verrou** qui vaut « menu ».
 */
const BY_LETTER: Record<string, Intent> = { e: "interact", f: "sit", m: "mute", t: "chat" };
const BY_CODE: Record<string, Intent> = {
  KeyE: "interact",
  KeyF: "sit",
  KeyM: "mute",
  Space: "playPause",
  ArrowLeft: "seekBack",
  ArrowRight: "seekForward",
  // L'invite au bas de l'image (passer l'intro, épisode suivant) : le pointeur est verrouillé, on ne peut pas
  // la cliquer — Entrée l'accepte, Retour arrière écarte la carte.
  Enter: "accept",
  NumpadEnter: "accept",
  Backspace: "dismiss",
  KeyT: "chat",
  // « Devine le film » : les chiffres par leur position (en AZERTY, sans Maj, la touche 1 donne « & »).
  Digit1: "choice1",
  Digit2: "choice2",
  Digit3: "choice3",
  Digit4: "choice4",
  Numpad1: "choice1",
  Numpad2: "choice2",
  Numpad3: "choice3",
  Numpad4: "choice4",
};
/** Les touches lues par leur position, jamais par leur lettre. */
const POSITIONAL = new Set(["Space", "Enter", "NumpadEnter", "Backspace", "Digit1", "Digit2", "Digit3", "Digit4", "Numpad1", "Numpad2", "Numpad3", "Numpad4"]);
const REPEATABLE = new Set<Intent>(["seekBack", "seekForward"]);

type Direction = "forward" | "back" | "left" | "right" | "run";
const BY_POSITION: Record<string, Direction> = { KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right", ShiftLeft: "run", ShiftRight: "run" };
const LETTERS: Record<"azerty" | "qwerty" | "qwertz", Record<string, Direction>> = {
  azerty: { z: "forward", s: "back", q: "left", d: "right" },
  qwerty: { w: "forward", s: "back", a: "left", d: "right" },
  qwertz: { w: "forward", s: "back", a: "left", d: "right" },
};

export type KeyboardChoice = "auto" | "azerty" | "qwerty" | "qwertz";

/** Les quatre lettres de déplacement d'une disposition forcée. */
export const FORCED_LABEL: Record<Exclude<KeyboardChoice, "auto">, string> = { azerty: "ZQSD", qwerty: "WASD", qwertz: "WASD" };

/** La lettre d'une touche, en minuscule — ou rien si ce n'est pas une lettre latine simple. */
const letterOf = (e: KeyboardEvent) => (e.key.length === 1 && /[a-z]/i.test(e.key) ? e.key.toLowerCase() : null);

export interface KeyboardMouseOptions {
  /** Le canevas : c'est lui qui prend le pointeur. */
  canvas: HTMLCanvasElement;
  /** Le regard tourne de tant de pixels. */
  onLook: (dx: number, dy: number) => void;
  /** Le verrou vient d'être pris ou perdu. */
  onCapture: (captured: boolean) => void;
  /** Les touches du monde sont-elles écoutées (visite en cours) ? Sinon l'interface a le clavier. */
  worldActive: () => boolean;
  /** La disposition choisie dans les réglages (`auto` : par position). */
  layout: () => KeyboardChoice;
  /** Les lettres de déplacement de ce clavier viennent d'être reconnues (« ZQSD », « WASD »). */
  onLayoutSeen: (label: string) => void;
}

/** Branche le clavier et la souris. Rend la fonction qui les débranche. */
export function attachKeyboardMouse({ canvas, onLook, onCapture, worldActive, layout, onLayoutSeen }: KeyboardMouseOptions): () => void {
  // Les touches tenues, par position physique → la direction qu'elles donnaient à l'appui (le relâchement
  // doit retirer la même, même si le réglage a changé entre-temps).
  const held = new Map<string, Direction>();
  const sync = () => {
    const on = (direction: Direction) => [...held.values()].includes(direction);
    motion.forward = (on("forward") ? 1 : 0) - (on("back") ? 1 : 0);
    motion.strafe = (on("right") ? 1 : 0) - (on("left") ? 1 : 0);
    motion.run = on("run");
  };
  /** La direction que donne cette touche, selon le réglage. */
  const directionOf = (e: KeyboardEvent): Direction | null => {
    const choice = layout();
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") return "run";
    if (choice === "auto") return BY_POSITION[e.code] ?? null;
    const letter = letterOf(e);
    return (letter && LETTERS[choice][letter]) || null;
  };
  // Ce que la première touche de la croix apprend de ce clavier : la lettre qu'elle porte.
  const seen: Record<string, string> = {};
  const learn = (e: KeyboardEvent) => {
    const letter = letterOf(e);
    if (!letter || !(e.code in BY_POSITION) || e.code.startsWith("Shift")) return;
    seen[e.code] = letter.toUpperCase();
    // Une seule suffit à trancher : la touche du haut porte Z en AZERTY, W ailleurs ; celle de gauche, Q ou A.
    if (seen.KeyW === "Z" || seen.KeyA === "Q") onLayoutSeen("ZQSD");
    else if (seen.KeyW === "W" || seen.KeyA === "A") onLayoutSeen("WASD");
  };
  const typing = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Escape") {
      // Pointeur libre (un panneau, un menu) : Échap arrive jusqu'ici, et veut dire « un cran en arrière ».
      e.preventDefault();
      emit("back");
      return;
    }
    // Une frappe dans un champ (la recherche du panneau) n'est pas un geste du visiteur.
    if (typing(e.target) || !worldActive()) return;
    learn(e);
    const direction = directionOf(e);
    if (direction) {
      held.set(e.code, direction);
      sync();
    }
    // Espace et les flèches par leur position ; les initiales (E, F, M) par leur lettre — et par leur
    // position seulement si ce clavier n'a pas de lettres latines.
    const letter = letterOf(e);
    // (Une ponctuation n'est pas « un clavier sans lettres latines » : en AZERTY, la virgule est à la place du M américain.)
    const foreignLetter = e.key.length === 1 && /\p{L}/u.test(e.key) && !letter;
    const intent = POSITIONAL.has(e.code) || e.code.startsWith("Arrow") ? BY_CODE[e.code] : letter ? BY_LETTER[letter] : foreignLetter ? BY_CODE[e.code] : undefined;
    // Une touche qui déplace ne fait rien d'autre (en disposition forcée, une lettre peut être les deux).
    if (!intent || (direction && direction !== "run")) return;
    // Espace et les flèches feraient défiler la page ou réactiveraient le dernier bouton cliqué.
    e.preventDefault();
    if (!e.repeat || REPEATABLE.has(intent)) emit(intent);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    held.delete(e.code);
    sync();
  };
  const onBlur = () => {
    held.clear();
    resetMotion();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas) return;
    // Chrome rend parfois un saut de plusieurs centaines de pixels au verrouillage : ignoré.
    if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
    onLook(e.movementX, e.movementY);
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 0 && document.pointerLockElement === canvas && worldActive()) emit("select");
  };
  // La molette rapproche l'image (assis seulement : c'est `Player` qui en décide). Un cran de molette vaut
  // un huitième de la course ; un pavé tactile envoie de petits pas, qui s'additionnent.
  const onWheel = (e: WheelEvent) => {
    if (!worldActive()) return;
    zoomBy(Math.max(-0.2, Math.min(0.2, -e.deltaY / 800)));
  };
  const onLockChange = () => {
    const captured = document.pointerLockElement === canvas;
    if (!captured) onBlur();
    onCapture(captured);
  };

  device.current = {
    // Le navigateur refuse le verrou hors d'un geste, et pendant la seconde qui suit un Échap : d'où le `catch`.
    capture() {
      if (document.pointerLockElement === canvas) return;
      try {
        const asked = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        asked?.catch?.(() => {});
      } catch {
        // Refusé : l'écran de reprise reste là, un nouveau geste réessaiera.
      }
    },
    release() {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    captured: () => document.pointerLockElement === canvas,
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("wheel", onWheel, { passive: true });
  document.addEventListener("pointerlockchange", onLockChange);
  return () => {
    document.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("pointerlockchange", onLockChange);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    resetMotion();
    device.current = { capture: () => {}, release: () => {}, captured: () => false };
  };
}

/**
 * Les lettres que portent les quatre touches de déplacement sur ce clavier (« ZQSD » en AZERTY).
 * `navigator.keyboard` n'existe que sur Chromium ; ailleurs, on devine à la langue.
 */
export async function movementKeyLabels(): Promise<string> {
  try {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
    // Sans cette interface (Firefox, Safari) : à la langue — l'AZERTY est le clavier de France et de
    // Belgique ; la Suisse et le Canada francophones, comme le reste du monde latin, ont W-A-S-D à cette
    // place. La première touche pressée corrigera (`onLayoutSeen`).
    if (!keyboard) return /^fr(-(FR|BE|LU|MC))?$/i.test(navigator.language) ? "ZQSD" : "WASD";
    const map = await keyboard.getLayoutMap();
    const label = ["KeyW", "KeyA", "KeyS", "KeyD"].map((code) => (map.get(code) ?? code.slice(3)).toUpperCase()).join("");
    return /^[A-Z]{4}$/.test(label) ? label : "WASD";
  } catch {
    return "WASD";
  }
}

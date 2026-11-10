import { device, emit, motion, resetMotion, type Intent } from "./intents";

/**
 * Le clavier et la souris : le seul périphérique d'aujourd'hui.
 *
 * - Les touches de déplacement sont lues par leur **position** (`event.code`) : sur un clavier AZERTY,
 *   les touches physiques W-A-S-D portent Z-Q-S-D, et c'est bien elles qu'on veut. Les libellés
 *   affichés suivent la disposition réelle (`movementKeyLabels`).
 * - Le regard : la souris, pointeur verrouillé. Échap ne parvient pas à la page tant qu'il l'est — le
 *   navigateur le garde pour rendre le pointeur. C'est donc la **perte du verrou** qui vaut « menu ».
 */
const INTENTS: Record<string, Intent> = {
  KeyE: "interact",
  KeyF: "sit",
  Space: "playPause",
  KeyM: "mute",
  ArrowLeft: "seekBack",
  ArrowRight: "seekForward",
};
const REPEATABLE = new Set<Intent>(["seekBack", "seekForward"]);
const MOVEMENT = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight"]);

export interface KeyboardMouseOptions {
  /** Le canevas : c'est lui qui prend le pointeur. */
  canvas: HTMLCanvasElement;
  /** Le regard tourne de tant de pixels. */
  onLook: (dx: number, dy: number) => void;
  /** Le verrou vient d'être pris ou perdu. */
  onCapture: (captured: boolean) => void;
  /** Les touches du monde sont-elles écoutées (visite en cours) ? Sinon l'interface a le clavier. */
  worldActive: () => boolean;
}

/** Branche le clavier et la souris. Rend la fonction qui les débranche. */
export function attachKeyboardMouse({ canvas, onLook, onCapture, worldActive }: KeyboardMouseOptions): () => void {
  const held = new Set<string>();
  const sync = () => {
    motion.forward = (held.has("KeyW") ? 1 : 0) - (held.has("KeyS") ? 1 : 0);
    motion.strafe = (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0);
    motion.run = held.has("ShiftLeft") || held.has("ShiftRight");
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
    if (MOVEMENT.has(e.code)) {
      held.add(e.code);
      sync();
    }
    const intent = INTENTS[e.code];
    if (!intent) return;
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
  document.addEventListener("pointerlockchange", onLockChange);
  return () => {
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
 * `navigator.keyboard` n'existe que sur Chromium ; ailleurs, on montre WASD.
 */
export async function movementKeyLabels(): Promise<string> {
  try {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
    if (!keyboard) return "WASD";
    const map = await keyboard.getLayoutMap();
    const label = ["KeyW", "KeyA", "KeyS", "KeyD"].map((code) => (map.get(code) ?? code.slice(3)).toUpperCase()).join("");
    return /^[A-Z]{4}$/.test(label) ? label : "WASD";
  } catch {
    return "WASD";
  }
}

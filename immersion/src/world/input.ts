/**
 * Le clavier du visiteur.
 *
 * Les touches de déplacement sont lues par leur **position** (`event.code`), pas par leur lettre :
 * sur un clavier AZERTY, les touches physiques W-A-S-D portent Z-Q-S-D, et c'est bien elles qu'on
 * veut. Les libellés affichés, eux, suivent la disposition réelle (`movementKeyLabels`).
 */
const held = new Set<string>();

export const keys = {
  has: (code: string) => held.has(code),
  clear: () => held.clear(),
};

export type Action = "interact" | "sit" | "playPause" | "mute" | "seekBack" | "seekForward";

const ACTIONS: Record<string, Action> = {
  KeyE: "interact",
  KeyF: "sit",
  Space: "playPause",
  KeyM: "mute",
  ArrowLeft: "seekBack",
  ArrowRight: "seekForward",
};

const MOVEMENT = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight"]);

/** Écoute le clavier tant que le composant qui l'a demandé est monté. Rend la fonction d'arrêt. */
export function listenKeyboard(onAction: (action: Action) => void, active: () => boolean): () => void {
  const down = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Une frappe dans un champ (la recherche du panneau) n'est pas un geste du visiteur.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (!active()) return;
    if (MOVEMENT.has(e.code)) held.add(e.code);
    const action = ACTIONS[e.code];
    if (action) {
      // Espace et les flèches feraient défiler la page ou réactiveraient le dernier bouton cliqué.
      e.preventDefault();
      if (!e.repeat || action === "seekBack" || action === "seekForward") onAction(action);
    }
  };
  const up = (e: KeyboardEvent) => held.delete(e.code);
  const blur = () => held.clear();
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  return () => {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
    window.removeEventListener("blur", blur);
    held.clear();
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

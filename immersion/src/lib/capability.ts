/**
 * Le mode se visite à la souris et au clavier, ou au doigt (`input/touch.ts`) : il lui faut l'un des deux, un
 * écran assez grand pour le panneau — pour un téléphone, tenu en paysage —, et WebGL 2. Chaque condition est
 * demandée au navigateur — jamais déduite du nom de l'appareil.
 */
export type Unsupported = "pointer" | "screen" | "rotate" | "webgl";

export const MIN_WIDTH = 900;
export const MIN_HEIGHT = 540;
/** Au doigt : un téléphone en paysage suffit. */
export const TOUCH_MIN_WIDTH = 560;
export const TOUCH_MIN_HEIGHT = 300;

/** Un appareil qui se pilote au doigt : pas de pointeur fin, et un écran qui sent les doigts. */
export function isTouchDevice(): boolean {
  return !window.matchMedia("(pointer: fine)").matches && (navigator.maxTouchPoints > 0 || "ontouchstart" in window);
}

/**
 * Sur un petit écran tactile, le panneau ne se pose pas dans le monde (réduit par la perspective, son texte
 * ferait quelques pixels) : il prend tout l'écran, à plat.
 */
export function flatPanel(): boolean {
  return isTouchDevice() && window.innerHeight < 620;
}

export function checkCapability(): Unsupported | null {
  const touch = isTouchDevice();
  if (!touch && !window.matchMedia("(pointer: fine)").matches) return "pointer";
  if (touch) {
    if (window.innerHeight > window.innerWidth) return "rotate";
    if (window.innerWidth < TOUCH_MIN_WIDTH || window.innerHeight < TOUCH_MIN_HEIGHT) return "screen";
  } else if (window.innerWidth < MIN_WIDTH || window.innerHeight < MIN_HEIGHT) return "screen";
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return "webgl";
    // Rend le contexte de l'essai tout de suite : un navigateur n'en garde qu'un petit nombre.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    return "webgl";
  }
  return null;
}

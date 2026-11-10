/**
 * Le mode demande un ordinateur : une souris (le regard se pilote au pointeur verrouillé), un écran
 * assez grand pour le panneau, et WebGL 2. Chaque condition est demandée au navigateur — jamais
 * déduite du nom de l'appareil.
 */
export type Unsupported = "pointer" | "screen" | "webgl";

export const MIN_WIDTH = 900;
export const MIN_HEIGHT = 540;

export function checkCapability(): Unsupported | null {
  if (!window.matchMedia("(pointer: fine)").matches) return "pointer";
  if (window.innerWidth < MIN_WIDTH || window.innerHeight < MIN_HEIGHT) return "screen";
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

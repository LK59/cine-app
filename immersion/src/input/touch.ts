import { device, emit, motion, resetMotion, zoomBy } from "./intents";

/**
 * L'écran tactile : la moitié gauche est un manche (on pose le pouce où l'on veut, on le fait glisser pour
 * marcher — poussé à fond, on court) ; la droite tourne le regard quand on y glisse un doigt, valide ce que
 * l'on vise quand on la touche brièvement, et rapproche l'image quand on y écarte deux doigts.
 *
 * Il n'y a pas de pointeur à verrouiller : « tenir le regard » n'est ici qu'un état, pris à l'entrée et
 * rendu quand un panneau s'ouvre.
 */

/** Le manche, pour le dessin (`ui/TouchControls`) : où le pouce s'est posé, où il est. */
export const stick = { active: false, x0: 0, y0: 0, x: 0, y: 0 };

/** Course du manche, en pixels : au-delà, on est à fond. */
export const STICK_REACH = 56;
/** Un doigt qui glisse tourne le regard plus vite qu'une souris qu'on déplace d'autant. */
const LOOK_GAIN = 2.6;

export interface TouchOptions {
  /** Ce qui reçoit les doigts : le canevas du monde. */
  surface: HTMLElement;
  onLook: (dx: number, dy: number) => void;
  onCapture: (captured: boolean) => void;
  worldActive: () => boolean;
}

export function attachTouch({ surface, onLook, onCapture, worldActive }: TouchOptions): () => void {
  let held = false;
  let stickId: number | null = null;
  const looks = new Map<number, { x: number; y: number; x0: number; y0: number; at: number }>();
  let pinch = 0;

  const release = () => {
    stickId = null;
    stick.active = false;
    looks.clear();
    pinch = 0;
    resetMotion();
  };
  const spread = () => {
    const [a, b] = [...looks.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onStart = (e: TouchEvent) => {
    if (!worldActive()) return;
    e.preventDefault();
    for (const touch of Array.from(e.changedTouches)) {
      if (stickId === null && touch.clientX < window.innerWidth * 0.42) {
        stickId = touch.identifier;
        Object.assign(stick, { active: true, x0: touch.clientX, y0: touch.clientY, x: touch.clientX, y: touch.clientY });
      } else {
        looks.set(touch.identifier, { x: touch.clientX, y: touch.clientY, x0: touch.clientX, y0: touch.clientY, at: performance.now() });
        if (looks.size === 2) pinch = spread();
      }
    }
  };
  const onMove = (e: TouchEvent) => {
    if (!worldActive()) return;
    e.preventDefault();
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === stickId) {
        stick.x = touch.clientX;
        stick.y = touch.clientY;
        const dx = (stick.x - stick.x0) / STICK_REACH;
        const dy = (stick.y - stick.y0) / STICK_REACH;
        const length = Math.hypot(dx, dy);
        const scale = length > 1 ? 1 / length : 1;
        // Une petite zone morte : un pouce posé ne fait pas dériver.
        motion.strafe = Math.abs(dx) < 0.12 ? 0 : dx * scale;
        motion.forward = Math.abs(dy) < 0.12 ? 0 : -dy * scale;
        motion.run = length > 0.94;
        continue;
      }
      const look = looks.get(touch.identifier);
      if (!look) continue;
      const dx = touch.clientX - look.x;
      const dy = touch.clientY - look.y;
      look.x = touch.clientX;
      look.y = touch.clientY;
      if (looks.size >= 2) {
        const now = spread();
        if (pinch > 0) zoomBy((now - pinch) / 260);
        pinch = now;
      } else onLook(dx * LOOK_GAIN, dy * LOOK_GAIN);
    }
  };
  const onEnd = (e: TouchEvent) => {
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === stickId) {
        stickId = null;
        stick.active = false;
        resetMotion();
        continue;
      }
      const look = looks.get(touch.identifier);
      if (!look) continue;
      looks.delete(touch.identifier);
      pinch = 0;
      // Un toucher bref, sans glisser : « valider ce que l'on vise ».
      if (worldActive() && e.type === "touchend" && performance.now() - look.at < 260 && Math.hypot(touch.clientX - look.x0, touch.clientY - look.y0) < 12) emit("select");
    }
  };

  device.current = {
    capture() {
      if (held) return;
      held = true;
      onCapture(true);
    },
    release() {
      if (!held) return;
      held = false;
      release();
      onCapture(false);
    },
    captured: () => held,
  };

  // Safari iOS : son geste de zoom à deux doigts sur la page, que `touch-action` ne retient pas toujours.
  const noGesture = (e: Event) => e.preventDefault();
  document.addEventListener("gesturestart", noGesture);
  const options = { passive: false } as const;
  surface.addEventListener("touchstart", onStart, options);
  surface.addEventListener("touchmove", onMove, options);
  surface.addEventListener("touchend", onEnd, options);
  surface.addEventListener("touchcancel", onEnd, options);
  return () => {
    surface.removeEventListener("touchstart", onStart);
    surface.removeEventListener("touchmove", onMove);
    surface.removeEventListener("touchend", onEnd);
    surface.removeEventListener("touchcancel", onEnd);
    document.removeEventListener("gesturestart", noGesture);
    release();
    device.current = { capture: () => {}, release: () => {}, captured: () => false };
  };
}

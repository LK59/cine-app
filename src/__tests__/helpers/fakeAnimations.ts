import { sheetMorphForTests } from "@/lib/sheetMorph/useSheetMorph";

/**
 * Les Web Animations, que jsdom n'a pas : de quoi voir ce que le mouvement des fiches demande au
 * navigateur (`useSheetMorph`) — quels éléments, quelles images clés, démarrées ou en pause.
 * Rien ne bouge vraiment : une animation « finit » quand le test l'appelle.
 */
export type FakeAnimation = {
  target: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
  paused: boolean;
  startTime: number | null;
  onfinish: (() => void) | null;
  finish: () => void;
};

export function installFakeAnimations(): { created: FakeAnimation[]; restore: () => void } {
  const created: FakeAnimation[] = [];
  function animate(this: Element, frames: Keyframe[], options?: number | KeyframeAnimationOptions) {
    const a: FakeAnimation & { effect: { target: Element }; cancel: () => void; pause: () => void; play: () => void; finished: Promise<void> } = {
      target: this,
      frames,
      options: typeof options === "number" ? { duration: options } : (options ?? {}),
      cancelled: false,
      paused: false,
      startTime: null,
      onfinish: null,
      effect: { target: this },
      finished: Promise.resolve(),
      cancel() {
        a.cancelled = true;
      },
      pause() {
        a.paused = true;
      },
      play() {
        a.paused = false;
      },
      finish() {
        a.onfinish?.();
      },
    };
    created.push(a);
    return a as unknown as Animation;
  }
  function getAnimations(this: Element) {
    return created.filter((a) => a.target === this && !a.cancelled) as unknown as Animation[];
  }
  Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true, writable: true });
  Object.defineProperty(Element.prototype, "getAnimations", { value: getAnimations, configurable: true, writable: true });
  return {
    created,
    restore: () => {
      delete (Element.prototype as { animate?: unknown }).animate;
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    },
  };
}

/** Les calques laissés par une fermeture que les minuteurs factices n'ont pas menée à son terme. */
export function clearMorphLayers(): void {
  for (const el of Array.from(document.querySelectorAll("[data-sheet-morph-layer]"))) el.remove();
  sheetMorphForTests.reset();
}

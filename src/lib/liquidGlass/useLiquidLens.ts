"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { LIQUID_SPRING, liquidTransform, prefersReducedMotion, pullFrom } from "./liquid";
import { springKeyframes } from "./spring";

/**
 * La lentille d'une barre de navigation (DECISIONS.md §45) — barre du téléphone, rail du bureau,
 * bascules Films/Séries.
 *
 * Une pastille posée sous l'élément actif (`[data-lens="<clé>"]`), qui glisse d'un élément à
 * l'autre sur le ressort et s'étire selon sa vitesse. Appuyée, elle se soulève sous le doigt et le
 * suit le long de la barre, et la barre entière gonfle et s'étire vers lui — plus légèrement que
 * les pilules du lecteur. Relâchée après un glisser, elle se pose sur l'élément le plus proche, et
 * `onDragSelect` le choisit ; un simple appui laisse la barre naviguer comme avant (au contact ou
 * au clic, selon la barre).
 *
 * Rien ne passe par React pendant le geste : `transform` écrit sur les nœuds, ressorts joués par
 * `element.animate()`, un calque à eux le temps du geste seulement.
 */

const LENS_LIFT = 1.15;
const BAR_SWELL = 1.03;
const BAR_STRENGTH = 0.5;
/** Au-delà de ce déplacement le long de la barre, l'appui devient un glisser. */
const DRAG_PX = 6;

const stretchFor = (v: number) => Math.min(Math.abs(v) / 3000, 0.22);

export type LensAxis = "x" | "y";

/** La pastille à une position (repère de la barre), gonflée de `swell`, étirée dans l'axe. */
export function lensTransform(main: number, cross: number, axis: LensAxis, swell: number, stretch: number): string {
  const along = swell * (1 + stretch);
  const across = swell * (1 - stretch * 0.45);
  return axis === "x"
    ? `translate(${main}px, ${cross}px) scale(${along}, ${across})`
    : `translate(${cross}px, ${main}px) scale(${across}, ${along})`;
}

export function useLiquidLens({
  barRef,
  lensRef,
  active,
  axis = "x",
  onDragSelect,
  relayout,
}: {
  barRef: RefObject<HTMLElement | null>;
  lensRef: RefObject<HTMLElement | null>;
  /** La clé de l'élément actif (`data-lens`), ou `null` : aucun (la pastille s'efface). */
  active: string | null;
  axis?: LensAxis;
  /** Un glisser fini sur un autre élément que l'actif ; `navigatedOnDown` : l'appui avait déjà navigué. */
  onDragSelect?: (key: string, navigatedOnDown: boolean) => void;
  /** Ce qui, en changeant, déplace les éléments (une barre compacte en paysage). */
  relayout?: unknown;
}): { moved: RefObject<boolean> } {
  /** Où la pastille est posée, et si un doigt la tient. */
  const lens = useRef({ main: 0, cross: 0, placed: false, held: false });
  const moved = useRef(false);
  const activeRef = useRef(active);
  const selectRef = useRef(onDragSelect);
  useEffect(() => {
    activeRef.current = active;
    selectRef.current = onDragSelect;
  });

  const itemOf = (bar: HTMLElement, key: string | null) =>
    key === null ? null : bar.querySelector<HTMLElement>(`[data-lens="${key}"]`);
  const mainOf = (el: HTMLElement) => (axis === "x" ? el.offsetLeft : el.offsetTop);
  const crossOf = (el: HTMLElement) => (axis === "x" ? el.offsetTop : el.offsetLeft);

  // La pastille suit l'élément actif : posée d'emblée la première fois, puis glissée sur le
  // ressort. Sa taille suit celle de l'élément — le rail du bureau s'élargit au survol.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const el = lensRef.current;
    if (!bar || !el) return;
    const place = (animate: boolean) => {
      const item = itemOf(bar, activeRef.current);
      const l = lens.current;
      if (!item) {
        el.style.opacity = "0";
        return;
      }
      el.style.opacity = "";
      el.style.width = `${item.offsetWidth}px`;
      el.style.height = `${item.offsetHeight}px`;
      const from = l.main;
      l.main = mainOf(item);
      l.cross = crossOf(item);
      if (l.held) return;
      el.style.transform = lensTransform(l.main, l.cross, axis, 1, 0);
      if (!animate || !l.placed || prefersReducedMotion() || typeof el.animate !== "function" || from === l.main) {
        l.placed = true;
        return;
      }
      const to = l.main;
      const cross = l.cross;
      const move = springKeyframes(from, to, LIQUID_SPRING, ({ x, v }) => ({ transform: lensTransform(x, cross, axis, 1, stretchFor(v)) }));
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(move.keyframes, { duration: move.duration, easing: "linear" });
    };
    place(true);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(bar);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la barre et l'axe ne changent pas
  }, [active, relayout]);

  // Le doigt sur la barre.
  useEffect(() => {
    const bar = barRef.current;
    const el = lensRef.current;
    const held = lens.current;
    if (!bar || !el) return;
    const items = () => Array.from(bar.querySelectorAll<HTMLElement>("[data-lens]"));
    const at = (e: PointerEvent) => (axis === "x" ? e.clientX : e.clientY);
    // `rest` : la barre au repos, mesurée une fois à l'appui — aucune lecture de mise en page par
    // mouvement du doigt.
    let drag: null | {
      pointerId: number;
      start: number;
      last: number;
      lastT: number;
      v: number;
      moved: boolean;
      w: number;
      h: number;
      rest: DOMRect;
      pull: { r: number; angle: number };
      navigatedOnDown: boolean;
    } = null;

    const clampMain = (pointer: number, rest: DOMRect) => {
      const all = items();
      const size = axis === "x" ? el.offsetWidth : el.offsetHeight;
      const raw = pointer - (axis === "x" ? rest.left : rest.top) - size / 2;
      const first = all[0];
      const last = all.at(-1);
      return first && last ? Math.min(Math.max(raw, mainOf(first) - 6), mainOf(last) + 6) : raw;
    };
    const barShape = (r: number, angle: number, swell: number) => liquidTransform(r, angle, swell, drag?.w ?? 0, drag?.h ?? 0, BAR_STRENGTH);

    const onDown = (e: PointerEvent) => {
      if (drag) return;
      moved.current = false;
      if ((e.pointerType === "mouse" && e.button !== 0) || prefersReducedMotion() || typeof el.animate !== "function") return;
      const item = (e.target as Element | null)?.closest?.<HTMLElement>("[data-lens]") ?? null;
      const key = item?.dataset.lens ?? null;
      bar.getAnimations().forEach((a) => a.cancel());
      bar.style.transform = "";
      drag = {
        pointerId: e.pointerId,
        start: at(e),
        last: at(e),
        lastT: e.timeStamp,
        v: 0,
        moved: false,
        w: bar.offsetWidth,
        h: bar.offsetHeight,
        rest: bar.getBoundingClientRect(),
        pull: { r: 0, angle: 0 },
        // Lu avant que l'élément ne navigue au contact (cet écouteur passe avant celui de React).
        navigatedOnDown: key !== null && key !== activeRef.current,
      };
      // Des calques à eux le temps du geste seulement : la barre floutée et la pastille bougent à
      // chaque mouvement du doigt, et sans calque chaque image repeignait la barre et son flou.
      bar.style.willChange = "transform";
      el.style.willChange = "transform";
      el.style.opacity = "";
      const l = lens.current;
      l.held = true;
      const target = item ? mainOf(item) : l.main;
      if (item) {
        el.style.width = `${item.offsetWidth}px`;
        el.style.height = `${item.offsetHeight}px`;
        l.cross = crossOf(item);
      }
      el.getAnimations().forEach((a) => a.cancel());
      const from = l.main;
      el.style.transform = lensTransform(target, l.cross, axis, LENS_LIFT, 0);
      const lift = springKeyframes(0, 1, LIQUID_SPRING, ({ x: p }) => ({
        transform: lensTransform(from + (target - from) * p, l.cross, axis, 1 + (LENS_LIFT - 1) * Math.min(p, 1.05), 0),
      }));
      el.animate(lift.keyframes, { duration: lift.duration, easing: "linear" });
      l.main = target;
      bar.style.transform = barShape(0, 0, BAR_SWELL);
      bar.animate([{ transform: "scale(1)" }, { transform: bar.style.transform }], { duration: 140, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.25)" });
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };

    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dt = Math.max(1, e.timeStamp - drag.lastT);
      drag.v = ((at(e) - drag.last) / dt) * 1000;
      drag.last = at(e);
      drag.lastT = e.timeStamp;
      const box = drag.rest;
      drag.pull = pullFrom(e.clientX - (box.left + box.width / 2), e.clientY - (box.top + box.height / 2), drag.w, drag.h);
      bar.getAnimations().forEach((a) => a.cancel());
      bar.style.transform = barShape(drag.pull.r, drag.pull.angle, BAR_SWELL);
      if (!drag.moved && Math.abs(at(e) - drag.start) < DRAG_PX) return;
      drag.moved = true;
      moved.current = true;
      const l = lens.current;
      l.main = clampMain(at(e), drag.rest);
      el.getAnimations().forEach((a) => a.cancel());
      el.style.transform = lensTransform(l.main, l.cross, axis, LENS_LIFT, stretchFor(drag.v));
    };

    const settle = (cancelled: boolean) => {
      const d = drag;
      if (!d) return;
      drag = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      // La barre revient sur le ressort.
      const { r, angle } = d.pull;
      bar.style.transform = "";
      const back = springKeyframes(1, 0, LIQUID_SPRING, ({ x }) => ({
        transform: liquidTransform(r * Math.max(x, -0.5), angle, 1 + (BAR_SWELL - 1) * x, d.w, d.h, BAR_STRENGTH),
      }));
      bar.getAnimations().forEach((a) => a.cancel());
      const settled = bar.animate(back.keyframes, { duration: back.duration, easing: "linear" });
      const release = () => {
        if (drag) return;
        bar.style.willChange = "";
        el.style.willChange = "";
      };
      // `finished` manque à certaines implémentations anciennes : l'habillage ne doit jamais lever.
      if (settled?.finished) settled.finished.then(release, release);
      else release();

      // La pastille se pose : sur l'élément le plus proche après un glisser, sinon sur l'actif.
      const l = lens.current;
      const all = items();
      let target: HTMLElement | undefined;
      if (d.moved && !cancelled) {
        target = all.reduce<HTMLElement | undefined>((best, it) => (!best || Math.abs(mainOf(it) - l.main) < Math.abs(mainOf(best) - l.main) ? it : best), undefined);
      }
      const targetKey = target?.dataset.lens ?? null;
      const current = activeRef.current;
      const rest = itemOf(bar, targetKey ?? current);
      const from = l.main;
      const to = rest ? mainOf(rest) : l.main;
      l.held = false;
      l.main = to;
      if (rest) {
        el.style.width = `${rest.offsetWidth}px`;
        el.style.height = `${rest.offsetHeight}px`;
        l.cross = crossOf(rest);
      } else {
        el.style.opacity = "0";
      }
      const cross = l.cross;
      el.style.transform = lensTransform(to, cross, axis, 1, 0);
      el.getAnimations().forEach((a) => a.cancel());
      if (from === to) {
        el.animate(
          [
            { transform: lensTransform(to, cross, axis, LENS_LIFT, 0) },
            { transform: lensTransform(to, cross, axis, 0.96, 0), offset: 0.5 },
            { transform: lensTransform(to, cross, axis, 1, 0) },
          ],
          { duration: 320, easing: "ease-out" },
        );
      } else {
        const span = Math.max(Math.abs(to - from), 1);
        const land = springKeyframes(
          from,
          to,
          LIQUID_SPRING,
          ({ x, v }) => ({ transform: lensTransform(x, cross, axis, 1 + (LENS_LIFT - 1) * Math.min(1, Math.abs(to - x) / span), stretchFor(v)) }),
          d.moved ? d.v : 0,
        );
        el.animate(land.keyframes, { duration: land.duration, easing: "linear" });
      }
      if (targetKey && targetKey !== current) selectRef.current?.(targetKey, d.navigatedOnDown);
    };
    const onUp = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.pointerId) settle(false);
    };
    const onCancel = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.pointerId) settle(true);
    };
    bar.addEventListener("pointerdown", onDown);
    return () => {
      bar.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      bar.style.transform = "";
      bar.style.willChange = "";
      held.held = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la barre et l'axe ne changent pas
  }, []);

  return { moved };
}

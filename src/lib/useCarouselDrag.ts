"use client";

import { useCallback, useRef, type CSSProperties, type RefObject } from "react";

/**
 * Un carrousel qui suit le doigt, sans redessiner l'écran à chaque pixel.
 *
 * La première version gardait le décalage dans l'état de React : chaque événement de pointeur —
 * cent vingt par seconde sur un téléphone récent — redessinait tout l'écran d'accueil, ses
 * rangées et ses affiches comprises. D'où une animation à cinq images par seconde pour un geste
 * qui ne demande qu'une propriété CSS.
 *
 * Pendant le geste, rien ne passe donc par React : la transformation est écrite directement sur
 * la piste, une fois par image d'écran. React ne reprend la main qu'au relâchement, quand il y a
 * effectivement quelque chose de nouveau à dire — un titre de plus ou de moins.
 */

/** En deçà, on ne sait pas encore ce que le doigt veut faire. */
const DEAD_ZONE_PX = 8;
/** La part de la largeur au-delà de laquelle on change de titre. */
const COMMIT_RATIO = 0.25;
/** px par milliseconde — un lancer, pas un déplacement lent qui a duré peu. */
const FLICK_VELOCITY = 0.4;
/**
 * Un lancer reste un déplacement.
 *
 * Sans ce plancher, une secousse de dix pixels sur deux millisecondes passe le seuil de vitesse
 * et change de titre : un doigt qui se repose sur l'affiche suffirait à la faire tourner.
 */
const FLICK_MIN_PX = 24;

export const CAROUSEL_TRANSITION = "transform 380ms cubic-bezier(0.32, 0.72, 0, 1)";

/** La position au repos d'une piste, pour un index donné. La même chaîne des deux côtés. */
export function carouselTransform(index: number, dx = 0): string {
  return `translate3d(calc(${-index * 100}% + ${dx}px), 0, 0)`;
}

type Axis = "undecided" | "horizontal" | "vertical";

export interface CarouselDrag {
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
  /** À poser sur le cadre : le navigateur garde l'axe vertical, nous prenons l'horizontal. */
  style: CSSProperties;
}

/**
 * La référence de la piste est passée par l'appelant, non rendue par le hook.
 *
 * Rendre une référence *dans un objet* fait considérer par l'analyse de React que toute lecture
 * d'une propriété de cet objet est une lecture de référence pendant le rendu — y compris celle
 * des gestionnaires d'événements, qui n'en sont pas. L'appelant garde donc la sienne, ce qui est
 * de toute façon la forme habituelle : une référence se déclare là où elle est posée.
 */
export function useCarouselDrag({
  trackRef,
  count,
  index,
  onIndexChange,
  onDragStateChange,
}: {
  trackRef: RefObject<HTMLDivElement | null>;
  count: number;
  index: number;
  onIndexChange: (next: number) => void;
  /**
   * Prévenu au début et à la fin du geste — deux fois, jamais à chaque pixel.
   *
   * L'appelant s'en sert pour suspendre la rotation automatique : sans cela elle se déclenchait
   * au milieu d'un geste, ce qui redessinait tout l'écran *et* remplaçait la transformation
   * écrite à la main par celle du nouvel index — la piste sautait sous le doigt.
   */
  onDragStateChange?: (dragging: boolean) => void;
}): CarouselDrag {
  const from = useRef<{ x: number; y: number; at: number } | null>(null);
  const axis = useRef<Axis>("undecided");
  const width = useRef(1);
  const frame = useRef<number | null>(null);
  const pending = useRef(0);

  /** Une écriture par image d'écran, quel que soit le nombre d'événements reçus entre-temps. */
  const paint = useCallback(
    (dx: number) => {
      pending.current = dx;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const track = trackRef.current;
        if (!track) return;
        track.style.transition = "none";
        track.style.transform = carouselTransform(index, pending.current);
      });
    },
    [index, trackRef]
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    from.current = { x: e.clientX, y: e.clientY, at: performance.now() };
    axis.current = "undecided";
    width.current = (e.currentTarget as HTMLElement).clientWidth || 1;
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = from.current;
      if (!start || axis.current === "vertical") return;
      const moveX = e.clientX - start.x;
      const moveY = e.clientY - start.y;

      if (axis.current === "undecided") {
        if (Math.abs(moveX) < DEAD_ZONE_PX && Math.abs(moveY) < DEAD_ZONE_PX) return;
        // Décidé une fois pour tout le geste : un doigt qui part en diagonale ne doit pas faire
        // hésiter l'affiche entre les deux.
        axis.current = Math.abs(moveX) > Math.abs(moveY) ? "horizontal" : "vertical";
        if (axis.current === "vertical") return;
        // La capture ne vient qu'ici : la prendre au premier contact volerait à la page les
        // gestes verticaux qui commencent sur l'affiche.
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        onDragStateChange?.(true);
      }

      // Aux extrémités, la piste résiste au lieu de partir dans le vide : la résistance dit
      // « il n'y a rien de ce côté » mieux qu'un blocage net.
      const atEdge = (moveX > 0 && index === 0) || (moveX < 0 && index === count - 1);
      paint(atEdge ? moveX * 0.35 : moveX);
    },
    [count, index, paint, onDragStateChange]
  );

  const finish = useCallback(
    (e: React.PointerEvent) => {
      const start = from.current;
      from.current = null;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      if (!start || axis.current !== "horizontal") {
        axis.current = "undecided";
        return;
      }
      axis.current = "undecided";
      onDragStateChange?.(false);
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

      const moved = e.clientX - start.x;
      const elapsed = Math.max(performance.now() - start.at, 1);
      const far = Math.abs(moved) > width.current * COMMIT_RATIO;
      const thrown = Math.abs(moved) >= FLICK_MIN_PX && Math.abs(moved) / elapsed > FLICK_VELOCITY;
      const wanted = index + (moved < 0 ? 1 : -1);
      const next = (far || thrown) && wanted >= 0 && wanted < count ? wanted : index;

      /**
       * La transformation d'arrivée est écrite ici, avec la transition rendue : le geste se
       * poursuit sans attendre le rendu de React. Celui-ci écrira ensuite la même chaîne, ce qui
       * ne se voit pas — c'est pourquoi les deux côtés passent par `carouselTransform`.
       *
       * La lecture d'`offsetWidth` entre les deux n'est pas une précaution : elle est la
       * correction. Rendre la transition et changer la transformation dans le même bloc ne
       * produit qu'un seul recalcul de style, où le navigateur voit d'un coup une transition
       * active *et* une valeur déjà changée — il n'a donc rien à interpoler et pose l'affiche
       * cible d'un trait. C'est la coupure sèche au relâchement. Ce coup d'œil sur la mise en
       * page force le recalcul intermédiaire : la transition part de là où le doigt a laissé la
       * piste, et le mouvement se termine tout seul.
       */
      const track = trackRef.current;
      if (track) {
        track.style.transition = CAROUSEL_TRANSITION;
        void track.offsetWidth;
        track.style.transform = carouselTransform(next);
      }
      if (next !== index) onIndexChange(next);
    },
    [count, index, onIndexChange, trackRef, onDragStateChange]
  );

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish },
    style: { touchAction: "pan-y" },
  };
}

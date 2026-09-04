"use client";

import { useCallback, useRef, useState, type CSSProperties } from "react";

/**
 * Un carrousel qui suit le doigt, sans prendre le défilement vertical à la page.
 *
 * Le balayage précédent se contentait de changer de titre au franchissement d'un seuil : rien ne
 * bougeait sous le doigt, et l'affiche se remplaçait d'un coup. Ici la piste est décalée en
 * continu — elle n'anime pas vers une cible, elle *est* là où le doigt l'a mise — et le
 * relâchement décide : au-delà du seuil, ou lancée assez vite pour que l'intention soit claire,
 * elle poursuit jusqu'au titre suivant ; sinon elle revient à sa place.
 *
 * L'axe se décide une fois, au premier déplacement qui sort de la zone morte, et ne change plus
 * de tout le geste. C'est ce qui empêche les deux défauts d'un carrousel dans une page qui
 * défile : une affiche qui part de travers pendant qu'on lit plus bas, et une page qui refuse de
 * défiler parce que le carrousel a confisqué le geste.
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

type Axis = "undecided" | "horizontal" | "vertical";

export interface CarouselDrag {
  /** Décalage courant en pixels. 0 au repos. */
  dx: number;
  /** Vrai tant qu'un doigt est posé et que le geste nous appartient. */
  dragging: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
  /** À poser sur la piste : le navigateur garde l'axe vertical, nous prenons l'horizontal. */
  style: CSSProperties;
}

export function useCarouselDrag({
  count,
  index,
  onIndexChange,
}: {
  count: number;
  index: number;
  onIndexChange: (next: number) => void;
}): CarouselDrag {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const from = useRef<{ x: number; y: number; at: number } | null>(null);
  const axis = useRef<Axis>("undecided");
  const width = useRef(1);

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
        setDragging(true);
        // La capture ne vient qu'ici : la prendre au premier contact volerait à la page les
        // gestes verticaux qui commencent sur l'affiche.
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }

      // Aux extrémités, la piste résiste au lieu de partir dans le vide : la résistance dit
      // « il n'y a rien de ce côté » mieux qu'un blocage net.
      const atEdge = (moveX > 0 && index === 0) || (moveX < 0 && index === count - 1);
      setDx(atEdge ? moveX * 0.35 : moveX);
    },
    [count, index]
  );

  const finish = useCallback(
    (e: React.PointerEvent) => {
      const start = from.current;
      from.current = null;
      if (!start || axis.current !== "horizontal") {
        axis.current = "undecided";
        return;
      }
      axis.current = "undecided";
      setDragging(false);
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

      const moved = e.clientX - start.x;
      const elapsed = Math.max(performance.now() - start.at, 1);
      const far = Math.abs(moved) > width.current * COMMIT_RATIO;
      const thrown = Math.abs(moved) >= FLICK_MIN_PX && Math.abs(moved) / elapsed > FLICK_VELOCITY;
      const next = index + (moved < 0 ? 1 : -1);

      // Le décalage revient à zéro dans le même temps que l'index change : la piste passe donc
      // sans à-coup de « là où le doigt l'a laissée » à « la place du titre suivant ».
      setDx(0);
      if ((far || thrown) && next >= 0 && next < count) onIndexChange(next);
    },
    [count, index, onIndexChange]
  );

  return {
    dx,
    dragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish },
    style: { touchAction: "pan-y" },
  };
}

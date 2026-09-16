"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Drag-down-to-close for a full-screen sheet, driven from one grab handle (here: the banner
// artwork at the top of the mobile detail sheet, above its Lire button).
//
// Same Pointer Events approach as ActionSheet's own swipe-to-close and the mini player's drag —
// mouse, touch and pen through one code path, no dependency. What this adds over those is that
// the sheet tracks the finger 1:1 for the whole gesture and can be dragged back up again: the
// offset is state, applied as a transform with the transition switched off while the finger is
// down, so nothing is animating towards a target — the sheet simply is where the finger is.
//
// Release decides: past the distance threshold, or thrown downwards fast enough that the intent
// is obvious even from a short drag, it closes; otherwise it springs back.

// A shade under a quarter of the screen, capped so a tall phone doesn't ask for a longer drag
// than a small one.
const DISTANCE_RATIO = 0.22;
const MAX_DISTANCE = 160;
// px per millisecond — a flick, not a slow drag that happened to be brief.
const VELOCITY_THRESHOLD = 0.5;

export interface SwipeToDismiss {
  /** Current downward offset in px. 0 when idle. */
  offset: number;
  /** True while a finger is down — the caller kills its transition so the sheet tracks 1:1. */
  dragging: boolean;
  /**
   * True from the first touch of the session onwards, offset back at 0 included. The caller uses
   * it to keep its CSS entrance animation off for good: that animation drives the same transform,
   * so letting it back in after a spring-back replays the whole entrance.
   */
  touched: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

export function useSwipeToDismiss(onDismiss: () => void): SwipeToDismiss {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [touched, setTouched] = useState(false);
  const active = useRef(false);
  const startY = useRef(0);
  const startedAt = useRef(0);
  const latest = useRef(0);
  /**
   * L'élément qui détient la capture, et pour quel pointeur.
   *
   * Retenus parce qu'il faut pouvoir la rendre — et que `finish` reçoit parfois un événement dont
   * la cible n'est plus celle qui l'avait prise. Le navigateur relâche seul à la levée du doigt ;
   * ce qu'il ne sait pas faire, c'est relâcher une capture dont l'élément a été **retiré du DOM**
   * pendant le geste. Sur WebKit, il cesse alors d'acheminer les pointeurs vers la page : tout
   * reste dessiné, plus rien ne répond, et seul un geste du navigateur en sort.
   *
   * Ce n'est pas théorique ici : ces fiches sont montées et démontées par la navigation, et depuis
   * qu'un titre différent est une instance différente, un appui rapide démonte l'élément porteur
   * du geste. `useCarouselDrag` rendait déjà la sienne ; celle-ci était la seule à ne pas le faire.
   */
  const held = useRef<{ element: HTMLElement; pointerId: number } | null>(null);

  const release = useCallback(() => {
    const capture = held.current;
    held.current = null;
    if (!capture) return;
    try {
      capture.element.releasePointerCapture(capture.pointerId);
    } catch {
      // Déjà rendue — à la levée du doigt, ou avec l'élément lui-même. Rien à réparer.
    }
  }, []);

  // Le filet : le démontage rend ce que le geste n'a pas eu l'occasion de rendre.
  useEffect(() => release, [release]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    active.current = true;
    startY.current = e.clientY;
    startedAt.current = performance.now();
    latest.current = 0;
    setDragging(true);
    setTouched(true);
    // Capture: the finger drags the sheet down out from under itself, so it leaves the handle
    // almost immediately — without this the gesture would die on the first pixel.
    //
    // Sous garde : la prise lève si le pointeur n'est plus actif — un appui déjà relâché quand
    // l'événement arrive, ce qui se produit sous les doigts pressés. Non rattrapée, l'exception
    // part d'un gestionnaire React et emporte l'arbre, pour un geste qui n'aurait rien fait.
    const element = e.currentTarget as HTMLElement;
    try {
      element.setPointerCapture(e.pointerId);
      held.current = { element, pointerId: e.pointerId };
    } catch {
      // Pas de capture : le geste suivra tant que le doigt reste sur l'élément, ce qui est déjà
      // mieux que rien, et le relâchement fonctionne à l'identique.
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!active.current) return;
    // Clamped at 0 rather than allowed to go negative: dragging back up returns the sheet
    // exactly to where it started and stops there, which is what "you can change your mind"
    // should feel like. Pulling it up beyond its own top edge would just tear it off the screen.
    const next = Math.max(0, e.clientY - startY.current);
    latest.current = next;
    setOffset(next);
  }, []);

  const finish = useCallback(() => {
    // Rendue avant toute autre chose, et même si le geste n'était pas actif : c'est la seule
    // ligne qui doit s'exécuter quoi qu'il arrive ensuite.
    release();
    if (!active.current) return;
    active.current = false;
    setDragging(false);

    const distance = latest.current;
    const elapsed = Math.max(performance.now() - startedAt.current, 1);
    const threshold = Math.min(MAX_DISTANCE, window.innerHeight * DISTANCE_RATIO);

    if (distance > threshold || distance / elapsed > VELOCITY_THRESHOLD) {
      // Carries on off the bottom instead of snapping back first — the close animation is the
      // continuation of the gesture, not a separate thing that happens after it.
      setOffset(window.innerHeight);
      onDismiss();
    } else {
      setOffset(0);
    }
  }, [onDismiss, release]);

  return {
    offset,
    dragging,
    touched,
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish },
  };
}

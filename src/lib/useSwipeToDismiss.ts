"use client";

import { useCallback, useRef, useState } from "react";
import { usePointerCapture } from "@/lib/usePointerCapture";

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
/**
 * En dessous, un geste n'est pas un geste : c'est un appui.
 *
 * La vitesse seule ne sait pas les distinguer. Un doigt qui se pose et se lève aussitôt bouge
 * toujours de deux ou trois pixels, et sur quatre millisecondes cela fait 0,75 px/ms — au-delà du
 * seuil, donc une fiche qui se referme parce qu'on l'a touchée. Ça n'arrive que sur un appui vif,
 * ce qui explique que ce soit resté longtemps invisible et que ce soit très déroutant quand ça
 * arrive : « au toucher, ça enlève la fiche ».
 *
 * Vingt-quatre pixels, c'est le seuil habituel au-delà duquel un appui devient un glissement.
 * La distance seule garde son propre seuil, bien plus grand : celui-ci ne fait qu'interdire au
 * raccourci de la vitesse de s'appliquer à quelque chose qui n'a pas bougé.
 */
export const MIN_FLICK_PX = 24;

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
  /**
   * Vrai une fois que c'est le geste lui-même qui a refermé la fiche.
   *
   * C'est la seule chose qui doive faire taire l'animation de sortie : la carte descend déjà par
   * sa transition, dans le prolongement du doigt, et `sheet-out` la ferait remonter d'un coup pour
   * la refaire descendre. Les fiches se servaient de `touched` pour ça, qui ne retombe jamais — si
   * bien qu'après un simple appui sur la bannière, ou un geste revenu en place, chaque fermeture
   * suivante (la croix, Échap, le retour) coupait net au lieu de glisser. Voir `sheetMotionClass`.
   *
   * `touched`, lui, reste tel quel : c'est l'*entrée* qu'il doit garder éteinte pour de bon.
   */
  dismissed: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

/**
 * À poser sur ce qui vit *dans* la poignée sans en faire partie — la croix de la bannière.
 *
 * L'appui y remontait jusqu'à la poignée : le geste démarrait, et la poignée prenait la capture
 * du pointeur — ce qui, sur Chrome pour Android, renvoie le `click` à l'élément qui capture : la
 * croix ne fermait rien. La fiche de bibliothèque arrêtait l'appui à la main ; la fiche découverte
 * l'avait oublié. Un seul objet, pour que la prochaine croix posée sur une bannière n'ait pas à
 * s'en souvenir.
 */
export const NOT_THE_HANDLE = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
} as const;

export function useSwipeToDismiss(onDismiss: () => void): SwipeToDismiss {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [touched, setTouched] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const active = useRef(false);
  const startY = useRef(0);
  const startedAt = useRef(0);
  const latest = useRef(0);
  // Prise et rendue par la primitive partagée : trois gestes de cette application capturent le
  // pointeur, et le protocole autour — rendre à la fin, rendre au démontage, ne pas lever sur un
  // pointeur déjà parti — est le seul morceau qu'ils ont en commun. Voir `usePointerCapture`.
  const capture = usePointerCapture();

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
    capture.take(e);
  }, [capture]);

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
    capture.release();
    if (!active.current) return;
    active.current = false;
    setDragging(false);

    const distance = latest.current;
    const elapsed = Math.max(performance.now() - startedAt.current, 1);
    const threshold = Math.min(MAX_DISTANCE, window.innerHeight * DISTANCE_RATIO);

    if (distance > threshold || (distance >= MIN_FLICK_PX && distance / elapsed > VELOCITY_THRESHOLD)) {
      // Carries on off the bottom instead of snapping back first — the close animation is the
      // continuation of the gesture, not a separate thing that happens after it.
      setOffset(window.innerHeight);
      setDismissed(true);
      onDismiss();
    } else {
      setOffset(0);
    }
  }, [onDismiss, capture]);

  return {
    offset,
    dragging,
    touched,
    dismissed,
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish },
  };
}

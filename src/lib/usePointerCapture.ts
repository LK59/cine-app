"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Prendre et rendre la capture d'un pointeur, sans jamais la laisser derrière soi.
 *
 * Trois gestes de cette application capturent le pointeur, et ils font trois choses différentes :
 * rejeter une fiche vers le bas, refermer une feuille d'action, déplacer le mini-lecteur en deux
 * dimensions. Ce n'est donc pas le geste qui est commun, c'est ce petit protocole autour — et il
 * avait été écrit trois fois, correctement une seule.
 *
 * Deux choses vont mal sans lui, et les deux ont été observées :
 *
 * 1. **Une capture qu'on ne rend pas.** Le navigateur relâche seul à la levée du doigt ; ce qu'il
 *    ne sait pas faire, c'est relâcher une capture dont l'élément a été retiré du DOM *pendant* le
 *    geste. Sur WebKit il cesse alors d'acheminer les pointeurs vers la page : tout reste dessiné,
 *    plus rien ne répond, et seul un geste du navigateur en sort. C'est arrivé le 16/09/2026 sur
 *    les fiches de titres absents de la bibliothèque, qui se démontent d'un appui à l'autre depuis
 *    qu'un titre différent est une instance différente.
 *
 * 2. **Une prise qui lève.** `setPointerCapture` refuse un pointeur qui n'est plus actif — un
 *    appui déjà relâché quand l'événement arrive, ce qui se produit sous les doigts pressés. Non
 *    rattrapée, l'exception part d'un gestionnaire React et emporte l'arbre, pour un geste qui
 *    n'aurait rien fait de toute façon.
 *
 * Le geste reste utilisable quand la prise échoue : il suivra tant que le doigt ne quitte pas
 * l'élément. C'est dégradé, pas cassé, et c'est très largement préférable à un écran mort.
 */
/**
 * Ce qu'on demande à la cible : savoir prendre et rendre.
 *
 * Décrite par sa forme et non par `instanceof Element`. Les deux se valent au navigateur, mais la
 * forme accepte aussi ce qui n'est pas un élément du document — et surtout elle n'oblige pas les
 * tests à construire un DOM pour vérifier un protocole qui ne parle que de deux appels.
 */
interface Capturable {
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
}

/** Le minimum d'un événement de pointeur dont ce crochet a besoin. */
export interface CaptureEvent {
  currentTarget: unknown;
  pointerId: number;
}

export interface PointerCapture {
  /** Prend la capture pour ce pointeur. Sans effet, et sans lever, si le navigateur refuse. */
  take: (event: CaptureEvent) => void;
  /** Rend la capture détenue, s'il y en a une. Appelable autant de fois qu'on veut. */
  release: () => void;
}

export function usePointerCapture(): PointerCapture {
  const held = useRef<{ element: Capturable; pointerId: number } | null>(null);

  const release = useCallback(() => {
    const capture = held.current;
    // Vidé d'abord : même si le relâchement lève, on ne doit pas croire qu'on détient encore
    // quelque chose — sans quoi la garde du démontage tenterait à nouveau, indéfiniment.
    held.current = null;
    if (!capture) return;
    try {
      capture.element.releasePointerCapture?.(capture.pointerId);
    } catch {
      // Déjà rendue — à la levée du doigt, ou avec l'élément lui-même. Rien à réparer.
    }
  }, []);

  const take = useCallback((event: CaptureEvent) => {
    const element = event.currentTarget as Capturable | null;
    if (typeof element?.setPointerCapture !== "function") return;
    try {
      element.setPointerCapture(event.pointerId);
      held.current = { element, pointerId: event.pointerId };
    } catch {
      // Voir le point 2 ci-dessus : le geste continue sans capture plutôt que de tout emporter.
    }
  }, []);

  // Le filet, et la raison d'être de ce crochet : le démontage rend ce que le geste n'a pas eu
  // l'occasion de rendre.
  useEffect(() => release, [release]);

  return { take, release };
}

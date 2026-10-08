"use client";

import { useCallback, useState } from "react";

/**
 * Un fondu d'arrivée qui ne joue qu'une fois (08/10/2026).
 *
 * Les volets gardés de l'accueil du téléphone — la bannière de l'onglet qu'on ne regarde pas, ses
 * rangées — sont cachés par `hidden`, c'est-à-dire `display: none`. Or une animation CSS repart de
 * zéro chaque fois que son élément est affiché de nouveau : chaque retour sur un onglet refaisait
 * le fondu de la bannière et de toutes les rangées, alors que rien n'arrivait — tout était déjà là.
 * La classe d'animation est donc retirée à la fin de sa première lecture.
 *
 * `onAnimationEnd` ne retient que l'animation de l'élément lui-même : celles de ses enfants
 * remontent jusqu'à lui (le scintillement d'un squelette, l'enfoncement d'une carte).
 */
export function useArrivalFade(): { arrived: boolean; onAnimationEnd: (e: React.AnimationEvent) => void } {
  const [arrived, setArrived] = useState(false);
  const onAnimationEnd = useCallback((e: React.AnimationEvent) => {
    if (e.target === e.currentTarget) setArrived(true);
  }, []);
  return { arrived, onAnimationEnd };
}

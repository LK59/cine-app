"use client";

import { useSyncExternalStore } from "react";

/**
 * Le simulateur d'iPad, sur un iPhone (16/10/2026) — un outil de test de l'administrateur.
 *
 * Lucas, sur iPad, voit l'interface large (la mise en page suit la taille de l'écran, l'interaction
 * le pointeur — voir `useIsTouch`), et certains touchers n'y prennent pas. Pour juger de cette
 * interface au doigt sans iPad, on demande à Safari de dessiner la page sur 1 180 px de large, la
 * largeur d'un iPad Air en paysage, réduite à l'écran : `useIsMobile` voit un écran large, le
 * navigateur sait toujours qu'il est touché (`hover: none`, `pointer: coarse`), et c'est le vrai
 * Safari d'iOS — ses gestes et sa règle du survol simulé compris, qu'aucun simulateur de bureau ne
 * reproduit. Un cadre au format iPad aurait demandé d'assouplir `frame-ancestors 'none'`.
 *
 * Rangé par appareil, jamais par compte : il ne change que le téléphone qui l'a activé. Le script
 * part avec le HTML (layout du cinéma), avant le premier dessin, sur la méta `viewport` que Next a
 * déjà écrite plus haut dans `<head>` ; entrer et sortir rechargent la page.
 */
export const IPAD_SIMULATOR_KEY = "cine:simu-ipad";
export const IPAD_SIMULATOR_WIDTH = 1180;

export function ipadSimulatorScript(): string {
  const key = JSON.stringify(IPAD_SIMULATOR_KEY);
  const content = JSON.stringify(`width=${IPAD_SIMULATOR_WIDTH}, viewport-fit=cover`);
  return `(function(){try{if(localStorage.getItem(${key})!=="1")return;var m=document.querySelector('meta[name="viewport"]');if(m)m.setAttribute("content",${content})}catch(e){}})()`;
}

function readOn(): boolean {
  try {
    return window.localStorage.getItem(IPAD_SIMULATOR_KEY) === "1";
  } catch {
    return false;
  }
}

/** Fixé au chargement : entrer ou sortir recharge la page, rien n'a à être suivi entre-temps. */
const noSubscribe = () => () => {};

export function useIpadSimulator(): boolean {
  return useSyncExternalStore(noSubscribe, readOn, () => false);
}

export function setIpadSimulator(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(IPAD_SIMULATOR_KEY, "1");
    else window.localStorage.removeItem(IPAD_SIMULATOR_KEY);
  } catch {
    // Stockage refusé (navigation privée) : rien ne serait gardé au rechargement.
    return;
  }
  window.location.reload();
}

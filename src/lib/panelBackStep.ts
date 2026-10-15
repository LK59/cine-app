"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Un écran poussé qui a ses propres étapes recule d'une étape avant de se fermer (15/10/2026, passe
 * de nuit, BUREAU-13).
 *
 * « Signaler un problème » avait deux « Retour » : celui du bas reculait d'une étape, celui du haut
 * — la flèche de `PlayerPanelFrame` — refermait tout l'assistant, et quatre choix plus une
 * description tapée disparaissaient sans un mot, sans brouillon. Même libellé, même flèche, deux
 * sens. L'écran déclare ici « je sais reculer » ; la flèche du haut (et Échap) le lui demande
 * d'abord, et ne referme que s'il répond qu'il est déjà à sa première étape.
 */
type Register = (step: (() => boolean) | null) => void;

export const PanelBackStepContext = createContext<Register | null>(null);

/** `step` rend vrai quand il a reculé ; faux à la première étape, et l'écran se ferme alors. */
export function usePanelBackStep(step: () => boolean): void {
  const register = useContext(PanelBackStepContext);
  const latest = useRef(step);
  useEffect(() => {
    latest.current = step;
  });
  useEffect(() => {
    if (!register) return;
    register(() => latest.current());
    return () => register(null);
  }, [register]);
}

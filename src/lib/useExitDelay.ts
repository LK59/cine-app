"use client";

import { useEffect, useState } from "react";

export interface ExitDelay {
  /** Vrai tant qu'il faut rendre le composant — y compris pendant son animation de sortie. */
  render: boolean;
  /** Vrai pendant cette animation : c'est ce qui pilote la classe de sortie. */
  leaving: boolean;
}

/**
 * Garder un écran monté le temps de son animation de sortie, quand c'est le *parent* qui décide.
 *
 * `useDelayedClose` règle le même problème de l'intérieur : un composant qui possède son propre
 * bouton de fermeture retarde l'appel à `onClose`. Ici, rien de tel n'est possible — les panneaux
 * et les fiches du lecteur sont rendus d'après l'adresse (`route.list`, `route.person`…), et
 * l'adresse change avant eux, par un retour du navigateur comme par un bouton. Ils disparaissaient
 * donc d'un coup, ce qui se voyait d'autant plus qu'ils arrivaient, eux, en glissant.
 *
 * L'état se règle pendant le rendu, à la façon de `useRotatingIndex` — c'est la forme que React
 * recommande pour dériver un état d'une entrée, et la seule que le compilateur accepte ici : un
 * `setState` synchrone dans un effet est refusé, et à raison.
 */
export function useExitDelay(active: boolean, exitMs: number): ExitDelay {
  const [phase, setPhase] = useState<"in" | "out" | "gone">(active ? "in" : "gone");
  const [wasActive, setWasActive] = useState(active);

  if (wasActive !== active) {
    setWasActive(active);
    // Une réouverture pendant la sortie reprend la main immédiatement, sans attendre le minuteur.
    setPhase(active ? "in" : "out");
  }

  useEffect(() => {
    if (phase !== "out") return;
    const timer = setTimeout(() => setPhase("gone"), exitMs);
    return () => clearTimeout(timer);
  }, [phase, exitMs]);

  return { render: phase !== "gone", leaving: phase === "out" };
}

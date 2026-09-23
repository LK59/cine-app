"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/lib/reducedMotion";

/**
 * Un nombre qui défile jusqu'à sa nouvelle valeur au lieu d'y sauter.
 *
 * Un compteur ou un pourcentage qui change sous les yeux — « Arrive · 63 % », le nombre de titres
 * d'un onglet, les chiffres de la gestion — sautait d'une valeur à l'autre ; défiler dit que la
 * valeur a bougé, et dans quel sens (23/09/2026). Rien au premier affichage : un nombre qui arrive
 * est déjà le bon. Rien non plus quand l'appareil demande moins de mouvement.
 *
 * `setState` dans les rappels d'image, jamais dans le corps de l'effet (règle du compilateur React).
 */
const DURATION_MS = 450;

export function useTweenedNumber(target: number): number {
  const [shown, setShown] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    const from = current.current;
    if (from === target || !Number.isFinite(target) || !Number.isFinite(from)) {
      current.current = target;
      if (from !== target) {
        const id = requestAnimationFrame(() => setShown(target));
        return () => cancelAnimationFrame(id);
      }
      return;
    }
    if (prefersReducedMotion()) {
      current.current = target;
      const id = requestAnimationFrame(() => setShown(target));
      return () => cancelAnimationFrame(id);
    }
    const start = performance.now();
    let id = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + (target - from) * eased;
      current.current = value;
      setShown(value);
      if (progress < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [target]);

  return shown;
}

/** Le même nombre, arrondi, à poser tel quel dans un texte. */
export function AnimatedNumber({ value }: { value: number }) {
  return <>{Math.round(useTweenedNumber(value))}</>;
}

"use client";

import { useEffect, useState } from "react";

/**
 * Le filet de l'arrivée du lecteur (10.29.2) : passé ce délai sans image, il se montre quand même.
 *
 * L'arrivée est posée à l'image suivante (`requestAnimationFrame`) et non au montage — l'état d'arrivée et l'état
 * d'entrée dans le même rendu ne laissent rien à animer. Mais tant que cette image ne vient pas, le cadre reste à
 * l'opacité 0 : sous charge, WebKit l'a tenu invisible 2,6 à 9,3 s (banc de bout en bout du 09/11/2026), le lecteur
 * jouant derrière l'accueil. 400 ms : bien au-delà d'une image (16 ms), assez court pour ne jamais se lire comme
 * une panne.
 */
export const REVEAL_FALLBACK_MS = 400;

/**
 * `false` au montage, `true` à l'image suivante — ou au bout de `REVEAL_FALLBACK_MS` si elle n'est pas venue.
 * Quand l'image vient d'abord (le cas ordinaire), le minuteur est annulé avant d'avoir servi : l'ordre de ce qui
 * se passe est celui d'avant.
 */
export function useRevealAfterFrame(): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      setRevealed(true);
    };
    const frame = requestAnimationFrame(reveal);
    timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      reveal();
    }, REVEAL_FALLBACK_MS);
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return revealed;
}

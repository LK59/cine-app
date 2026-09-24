import type { KeyboardEvent } from "react";

/**
 * Échap dans un champ de saisie : il quitte le champ, il ne ferme pas le panneau.
 *
 * Le panneau écoute Échap sur toute la fenêtre pour se refermer (`PlayerPanelFrame`) ; dans
 * l'assistant ou une réponse, la touche emportait tout ce qui était tapé et les photos choisies,
 * sans rien demander (relu le 24/09/2026). `data-owns-escape` le fait s'effacer ; la touche retire
 * alors le focus du champ, et une seconde pression ferme le panneau comme ailleurs.
 */
export const escapeBlurs = {
  "data-owns-escape": true,
  onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") e.currentTarget.blur();
  },
} as const;

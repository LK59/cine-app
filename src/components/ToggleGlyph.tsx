"use client";

import { useState, type ReactNode } from "react";

/**
 * L'icône d'un bouton à deux états — « À voir », « Vu » — qui confirme le geste.
 *
 * L'icône changeait d'un coup : on appuyait, et rien ne disait que l'appui avait été pris. Passée à
 * l'état actif, elle rebondit légèrement et son tracé se dessine ; revenue à l'état de repos, elle
 * se repose simplement (23/09/2026). Pas de fenêtre, pas de texte : la confirmation tient dans
 * l'icône elle-même.
 *
 * **Seulement quand l'état change.** Ouvrir une fiche sur un film déjà vu ne doit rien animer :
 * l'animation dit « tu viens de le faire », pas « c'est ainsi ». D'où `changed`, qui ne devient
 * vrai qu'au premier changement après le montage — retenu pendant le rendu, comme ailleurs dans
 * l'application, et non dans un effet. La clé suit l'état : chaque changement monte un nœud neuf,
 * et l'animation repart.
 *
 * « Réduire les animations » : la règle générale de globals.css la ramène à rien.
 */
export function ToggleGlyph({ on, onIcon, offIcon }: { on: boolean; onIcon: ReactNode; offIcon: ReactNode }) {
  const [lastOn, setLastOn] = useState(on);
  const [changed, setChanged] = useState(false);
  if (on !== lastOn) {
    setLastOn(on);
    setChanged(true);
  }
  const motion = changed ? (on ? "toggle-on" : "toggle-off") : "";
  return (
    <span key={on ? "on" : "off"} data-toggle-glyph={on ? "on" : "off"} className={`inline-flex ${motion}`}>
      {on ? onIcon : offIcon}
    </span>
  );
}

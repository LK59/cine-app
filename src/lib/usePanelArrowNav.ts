"use client";

import { useEffect, type RefObject } from "react";
import { chooseNext, type ArrowKey, type NavRect } from "@/lib/panelArrowNav";

/** Ce qui participe à la navigation aux flèches. Marqué explicitement, jamais deviné. */
export const NAV_ITEM_ATTR = "data-nav-item";

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * Est-on en train d'écrire ?
 *
 * C'est la garde qui décide de tout : dans un champ, les flèches déplacent le curseur, et dans une
 * liste déroulante elles changent la valeur. Les intercepter là casserait des gestes que tout le
 * monde connaît — et « sans casser les focus » veut dire exactement ça.
 */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    // Une barre de défilement horizontale se parcourt aussi aux flèches quand elle a le focus.
    target.getAttribute("role") === "slider"
  );
}

/**
 * Naviguer aux flèches dans un panneau du lecteur.
 *
 * Les rangées de l'écran d'accueil se parcourent aux flèches depuis toujours ; les panneaux qui se
 * posent par-dessus — recherche, Ma liste, la grille complète — non, et on y arrivait donc au
 * clavier sans pouvoir en sortir autrement qu'à la tabulation, case par case.
 *
 * Trois règles, et elles suffisent :
 *
 *  * l'écouteur est posé sur le conteneur, pas sur la fenêtre : un panneau ne peut pas voler les
 *    flèches d'un écran qu'il ne recouvre pas ;
 *  * il ne fait rien tant qu'on écrit — voir `typingIn` ;
 *  * il ne consomme la touche que s'il a réellement déplacé le focus. Au bord d'une grille, la
 *    touche repart à la page, qui la traduit en défilement.
 *
 * Les éléments participants sont marqués (`data-nav-item`) plutôt que déduits de ce qui est
 * focalisable : un panneau contient des boutons de fermeture, des onglets et des cartes, et les
 * mélanger dans une même grille donnerait des déplacements incompréhensibles.
 */
export function usePanelArrowNav(container: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const root = container.current;
    if (!root || !enabled) return;

    function onKeyDown(e: KeyboardEvent) {
      if (!ARROWS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (typingIn(e.target)) return;
      const host = container.current;
      if (!host) return;

      const items = Array.from(host.querySelectorAll<HTMLElement>(`[${NAV_ITEM_ATTR}]`));
      if (items.length === 0) return;

      const current = items.indexOf(document.activeElement as HTMLElement);
      const rects: NavRect[] = items.map((item) => {
        const box = item.getBoundingClientRect();
        return { top: box.top, left: box.left, width: box.width, height: box.height };
      });

      const next = chooseNext(rects, current, e.key as ArrowKey);
      if (next === null) return;

      e.preventDefault();
      items[next].focus({ preventScroll: true });
      // Centré verticalement plutôt qu'aligné au bord : une carte tout juste amenée sous la barre
      // d'outils collante est visible sans être lisible.
      items[next].scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [container, enabled]);
}

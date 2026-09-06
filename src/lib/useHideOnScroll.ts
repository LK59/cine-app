"use client";

import { useEffect, useRef, useState } from "react";

/** En dessous de ça, un mouvement est une hésitation, pas une intention de descendre. */
const THRESHOLD = 12;

/** Au-dessus de ce point, on est en haut : la barre revient quoi qu'il arrive. */
const TOP_ZONE = 32;

/**
 * Cacher quelque chose quand on descend, le rendre quand on remonte.
 *
 * Le comportement standard d'une barre flottante, et ce qui permet d'en avoir une sans perdre
 * l'image pleine page : elle est là quand on arrive et quand on revient, absente pendant qu'on
 * parcourt.
 *
 * L'écoute est posée sur le document **en phase de capture**. Les événements de défilement ne
 * remontent pas, mais ils descendent : c'est la seule façon d'entendre n'importe quel conteneur
 * défilant de l'application — l'accueil, un panneau, une fiche — sans que chacun ait à se
 * déclarer. Et cette interface n'en a aucun au niveau de la fenêtre : tout défile dans des boîtes.
 *
 * L'état n'est écrit que lorsqu'il change vraiment, et la mesure est repoussée à l'image suivante :
 * un doigt qui glisse produit des dizaines d'événements par seconde, et redessiner à chaque fois
 * une barre qui ne bouge pas serait le plus sûr moyen de rendre le défilement saccadé.
 */
export function useHideOnScroll(enabled = true): boolean {
  const [hidden, setHidden] = useState(false);
  // Le dernier point connu de chaque conteneur : plusieurs peuvent défiler dans la même session
  // — l'accueil derrière, un panneau devant — et comparer leurs positions entre elles n'aurait
  // aucun sens.
  const lastTop = useRef(new WeakMap<EventTarget, number>());
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    function onScroll(e: Event) {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const top = target.scrollTop;
        const previous = lastTop.current.get(target) ?? 0;
        lastTop.current.set(target, top);
        if (top <= TOP_ZONE) {
          setHidden(false);
          return;
        }
        const delta = top - previous;
        if (delta > THRESHOLD) setHidden(true);
        else if (delta < -THRESHOLD) setHidden(false);
      });
    }

    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [enabled]);

  // Désactivé, on rend « visible » sans toucher à l'état : le poser dans l'effet provoquerait un
  // rendu en cascade pour une valeur qui se déduit.
  return enabled && hidden;
}

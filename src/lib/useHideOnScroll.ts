"use client";

import { useEffect, useRef, useState } from "react";

/** En dessous de ça, un mouvement est une hésitation, pas une intention de descendre. */
const THRESHOLD = 12;

/** Au-dessus de ce point, on est en haut : la barre revient quoi qu'il arrive. */
const TOP_ZONE = 32;

/**
 * La barre réapparaît, et le prochain déplacement ne compte pas comme un défilement.
 *
 * Chaque onglet du cinéma retrouve sa propre hauteur (`useTabScrollMemory`) : passer de Séries,
 * en haut, à Films, plus bas, déplaçait le conteneur d'un coup — lu comme une descente, la barre
 * disparaissait sur Films et restait sur Séries (Louis, 25/09/2026). Une seule règle désormais :
 * elle se cache quand on descend, revient dès qu'on remonte, et revient toujours à un changement
 * d'onglet, quelle que soit la hauteur de l'onglet d'arrivée.
 */
const REVEAL_EVENT = "cine:reveal-navigation";
/** Le temps pendant lequel un déplacement est celui qu'on vient de faire, pas celui du doigt. */
const REVEAL_QUIET_MS = 400;

export function revealNavigation(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REVEAL_EVENT));
}

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
  const quietUntil = useRef(0);

  /**
   * Reprendre la main, c'est repartir visible.
   *
   * Le crochet est mis en sommeil pendant qu'une fiche recouvre l'écran — et le défilement de
   * cette fiche le laissait « caché ». En refermant, on découvrait une barre absente qu'il fallait
   * aller rechercher en remontant. L'ajustement se fait pendant le rendu, la forme que React
   * recommande pour dériver un état d'une entrée et la seule que le compilateur accepte ici.
   */
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (enabled) setHidden(false);
  }

  useEffect(() => {
    if (!enabled) return;

    function onScroll(e: Event) {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      // Une rangée qui défile de côté n'a pas de hauteur à parcourir : son `scrollTop` vaut
      // toujours zéro, ce qui se lisait « revenu en haut » — faire glisser une rangée d'affiches
      // ramenait la barre (23/09/2026).
      if (target.scrollHeight <= target.clientHeight) return;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const top = target.scrollTop;
        const previous = lastTop.current.get(target) ?? 0;
        lastTop.current.set(target, top);
        // Le déplacement d'un changement d'onglet : retenu comme point de départ, pas comme geste.
        if (performance.now() < quietUntil.current) return;
        if (top <= TOP_ZONE) {
          setHidden(false);
          return;
        }
        const delta = top - previous;
        if (delta > THRESHOLD) setHidden(true);
        else if (delta < -THRESHOLD) setHidden(false);
      });
    }

    function onReveal() {
      quietUntil.current = performance.now() + REVEAL_QUIET_MS;
      setHidden(false);
    }

    document.addEventListener("scroll", onScroll, true);
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener(REVEAL_EVENT, onReveal);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [enabled]);

  // Désactivé, on rend « visible » sans toucher à l'état : le poser dans l'effet provoquerait un
  // rendu en cascade pour une valeur qui se déduit.
  return enabled && hidden;
}

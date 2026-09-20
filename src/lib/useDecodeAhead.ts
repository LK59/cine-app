"use client";

import { useEffect, type RefObject } from "react";

/**
 * Décoder les affiches avant qu'on les regarde.
 *
 * La grille complète saccadait **en descendant seulement**, et trois correctifs n'y avaient pas
 * suffi. Le banc a fini par nommer la cause (20/09/2026, `content-visibility`, le fondu et la
 * taille des affiches tour à tour neutralisés, processeur bridé six fois pour que les écarts se
 * voient) : ce qui coûte, c'est **une affiche qui arrive pendant le défilement**. Les mêmes six
 * secondes de molette parcourent 2 790 px quand les images arrivent en chemin, et 5 804 px quand
 * elles sont déjà là. Le reste — la structure des cartes, leurs transitions, `content-visibility` —
 * pèse le tiers de cet écart. En remontant, tout est déjà décodé : d'où l'asymétrie, et d'où le
 * fait qu'aucun réglage de mise en page ne l'ait jamais corrigée.
 *
 * Anticiper le *téléchargement* ne change rien, et c'est mesuré aussi : le coût n'est pas
 * d'attendre les octets, c'est de décoder l'image et de la peindre à l'image près où elle entre
 * dans le champ. `decode()` est la seule fonction qui déplace ce travail hors de ce moment-là.
 *
 * Trois mille pixels d'avance — deux écrans et demi. Mesuré contre 1 500, qui ne rattrape pas une
 * molette lancée, et contre le fait de tout décoder d'avance, qui reviendrait à charger six cent
 * soixante-dix affiches pour trois rangées regardées.
 *
 * L'image de chauffe est jetée aussitôt : ce n'est pas elle qui s'affiche, c'est le cache de
 * décodage du navigateur qu'on remplit, et la carte y puisera quand son tour viendra.
 */
const AHEAD_PX = 3000;

export function useDecodeAhead(grid: RefObject<HTMLElement | null>, items: unknown): void {
  useEffect(() => {
    const root = grid.current;
    if (!root || typeof IntersectionObserver === "undefined") return;

    // Une affiche décodée deux fois ne coûte rien de plus au navigateur, mais deux requêtes
    // partiraient si le cache HTTP l'avait laissée filer : la même adresse ne se chauffe qu'une.
    const chauffees = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          const img = entry.target.querySelector("img");
          const src = img?.getAttribute("src");
          if (!src || chauffees.has(src)) continue;
          chauffees.add(src);
          const chauffe = new Image();
          chauffe.src = src;
          // `decode` n'existe pas partout, et rejette pour une image absente — deux raisons de
          // ne jamais laisser cet appel remonter : c'est du confort, sur le chemin de personne.
          chauffe.decode?.().catch(() => {});
        }
      },
      { rootMargin: `${AHEAD_PX}px 0px` }
    );

    for (const card of root.children) observer.observe(card);
    return () => observer.disconnect();
    /**
     * **La liste elle-même, et non son nombre d'éléments.**
     *
     * Première version : `items.length`. Elle a l'air prudente et elle est fausse — changer le
     * tri garde exactement le même nombre de cartes, donc l'effet ne repartait pas. Or
     * l'observateur cesse de suivre chaque carte dès qu'il l'a chauffée (`unobserve`) : après un
     * changement de tri, le premier écran n'était plus anticipé du tout, précisément là où
     * quelqu'un se remet à faire défiler.
     *
     * La liste est mémoïsée par l'appelant sur ses filtres, donc son identité ne change que
     * lorsque son contenu change : c'est exactement la dépendance qu'il fallait.
     */
  }, [grid, items]);
}

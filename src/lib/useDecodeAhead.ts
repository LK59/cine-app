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
 * Ce n'est pas l'image de chauffe qui s'affiche : c'est le cache de décodage du navigateur qu'on
 * remplit, et la carte y puisera quand son tour viendra. Elle est tenue un moment — voir `KEPT`.
 */
const AHEAD_PX = 3000;

/**
 * Combien d'affiches chauffées restent tenues, au plus — deux fois ce que couvrent les 3 000 px
 * de part et d'autre de l'écran sur un téléphone (trois colonnes, ≈ 45 cartes).
 *
 * Tenues, parce qu'une image jetée aussitôt laisse le navigateur libre d'oublier son décodage : sur
 * un iPhone, six cent quatre-vingts affiches décodées pèsent près d'un demi-gigaoctet, et il les
 * oublie. En remontant, elles étaient alors redécodées au moment d'entrer dans le champ — l'à-coup
 * dans les deux sens que Louis décrivait le 21/09/2026, sur « Tous les films » (702 titres) et
 * jamais sur les séries (137, qui tiennent en mémoire). Bornées, pour ne pas remplacer un
 * demi-gigaoctet oublié par un demi-gigaoctet retenu : les plus anciennes sont lâchées.
 */
const KEPT = 90;

/**
 * Le conteneur qui défile vraiment — celui qui doit servir de racine à l'observateur.
 *
 * La grille défile dans le corps de son panneau, pas dans la page. Un observateur sans racine
 * mesure contre la fenêtre, et le navigateur rogne d'abord chaque carte par ce conteneur : une
 * carte à 1 000 px sous le bord n'y a plus aucune surface, quelle que soit la marge. L'avance de
 * 3 000 px valait donc **zéro** depuis le 20/09 — mesuré le 21/09 dans Chromium et WebKit : douze
 * affiches chauffées au repos (l'écran), quarante-cinq avec cette racine. Le banc du 20/09 faisait
 * défiler la page elle-même, et ne pouvait pas le voir.
 */
function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

export function useDecodeAhead(grid: RefObject<HTMLElement | null>, items: unknown): void {
  useEffect(() => {
    const root = grid.current;
    if (!root || typeof IntersectionObserver === "undefined") return;

    // Adresse → image de chauffe, dans l'ordre d'usage : la plus ancienne est la première lâchée.
    const kept = new Map<string, HTMLImageElement>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target.querySelector("img");
          const src = img?.getAttribute("src");
          if (!src) continue;
          // Déjà tenue : elle redevient la plus récente, et rien n'est redemandé.
          const held = kept.get(src);
          if (held) {
            kept.delete(src);
            kept.set(src, held);
            continue;
          }
          const chauffe = new Image();
          chauffe.src = src;
          // `decode` n'existe pas partout, et rejette pour une image absente — deux raisons de
          // ne jamais laisser cet appel remonter : c'est du confort, sur le chemin de personne.
          chauffe.decode?.().catch(() => {});
          kept.set(src, chauffe);
          if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
        }
      },
      // Chaque carte reste suivie : elle se rechauffe à chaque fois qu'elle rentre dans la marge,
      // en descendant comme en remontant.
      { root: scrollingAncestor(root), rootMargin: `${AHEAD_PX}px 0px` }
    );

    for (const card of root.children) observer.observe(card);
    return () => {
      observer.disconnect();
      kept.clear();
    };
    /**
     * **La liste elle-même, et non son nombre d'éléments.**
     *
     * Première version : `items.length`. Elle a l'air prudente et elle est fausse — changer le
     * tri garde exactement le même nombre de cartes, donc l'effet ne repartait pas. Or
     * l'observateur ne suivait que les cartes présentes à son montage : après un changement de
     * tri, le premier écran n'était plus anticipé du tout, précisément là où quelqu'un se remet à
     * faire défiler.
     *
     * La liste est mémoïsée par l'appelant sur ses filtres, donc son identité ne change que
     * lorsque son contenu change : c'est exactement la dépendance qu'il fallait.
     */
  }, [grid, items]);
}

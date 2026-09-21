"use client";

import type { CinemaRoute } from "@/lib/cinemaRoute";

/**
 * La grille du bureau est-elle l'écran du dessus ?
 *
 * Six décisions de `CinemaClient` en dépendent — les flèches (`useTvGridNav`), la carte centrée au
 * doigt (`useCentredCard`), le raccourci « / », `inert` sur la grille, la rotation des deux
 * bannières, et le focus rendu à une carte en refermant une fiche. Chacune avait sa propre
 * condition, recopiée à la main, et aucune n'était la même : les flèches ignoraient la grille
 * complète et les fiches TMDB, la carte centrée ignorait la grille complète, « / » ignorait les
 * fiches TMDB, et le focus rendu ne regardait que la pile des fiches. Relevé le 21/09/2026 : dans
 * la grille complète, une flèche envoyait le focus sur une affiche *cachée* de l'accueil, et
 * Entrée ouvrait alors un film que personne n'avait vu passer.
 *
 * Une seule réponse, lue dans l'adresse — c'est elle qui dit ce qui est ouvert, et non ce que tel
 * composant croit avoir résolu.
 */

/** Quelque chose recouvre la grille : une fiche, un panneau du rail, la grille complète. */
export function coversGrid(route: CinemaRoute): boolean {
  return (
    route.film !== null ||
    route.serie !== null ||
    route.discover !== null ||
    route.person !== null ||
    route.browse !== null ||
    route.search ||
    route.list ||
    route.account
  );
}

/**
 * La grille est à l'écran et à elle le clavier.
 *
 * Le lecteur plein écran compte aussi — il possède le clavier — mais **pas** pour `inert` : rendre
 * la grille inerte sous le lecteur ferait perdre le focus à la carte qui l'a lancé, et le retour
 * repartirait de la première affiche. Voir `CinemaClient`.
 */
export function gridIsTop(route: CinemaRoute, playerMode: string): boolean {
  return !coversGrid(route) && playerMode !== "full";
}

/**
 * Refermer la fiche du dessus découvrira-t-il la grille ?
 *
 * Non si une autre fiche attend dessous (`sheetBehind`), et non plus si la fiche avait été ouverte
 * depuis la recherche, « Ma liste » ou la grille complète : l'adresse les garde sous la fiche, et
 * c'est eux qu'on retrouve. La règle d'avant ne regardait que la pile — le focus partait donc vers
 * une affiche cachée de l'accueil, et la première flèche dans la recherche retrouvée déplaçait une
 * grille qu'on ne voyait pas.
 */
export function closeUncoversGrid(route: CinemaRoute, sheetBehind: boolean): boolean {
  return !sheetBehind && !coversGrid({ ...route, film: null, serie: null, episodes: false });
}

/**
 * La carte de la grille qui a le focus, s'il y en a une — celle à qui le rendre au retour.
 *
 * `document.activeElement` seul ne suffit pas : les titres similaires et les sagas ouvrent leur
 * fiche par le même rappel, depuis *l'intérieur* d'une fiche. On retenait alors un bouton de la
 * fiche, démonté dès qu'elle se refermait, et le focus tombait sur `<body>` — la première flèche
 * repartait de la première affiche, en haut de la page.
 */
export function gridCardInFocus(pane: HTMLElement | null): HTMLElement | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (!pane || !(active instanceof HTMLElement) || !pane.contains(active)) return null;
  return active.closest<HTMLElement>("[data-tv-card]");
}

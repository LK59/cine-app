/**
 * Une image que le navigateur a déjà s'affiche sans refaire son fondu d'arrivée.
 *
 * Le fondu dit « cette image vient d'arriver ». Il se rejouait à chaque remontage d'une image que
 * le navigateur avait déjà — chaque retour sur une page, chaque rangée revenue à l'écran —, une
 * demi-seconde de gris pour une image disponible (23/09/2026). Une image que le navigateur a déjà
 * est `complete` dès son insertion : elle s'affiche sans transition.
 *
 * À passer comme `ref`, tel quel : une fonction de module, donc stable, que React n'appelle qu'au
 * montage — un rendu du parent pendant un vrai fondu ne vient pas le couper.
 */
export function showIfAlreadyLoaded(img: HTMLImageElement | null): void {
  if (img && img.complete && img.naturalWidth > 0) {
    img.style.transition = "none";
    img.style.opacity = "1";
  }
}

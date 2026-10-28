import type { ReaderTurn } from "@/lib/books/readerPrefs";

/**
 * Les animations de page du lecteur de livres (DECISIONS.md §127).
 *
 * foliate-js tourne la page en faisant défiler ses colonnes ; il ne sait pas en montrer deux à la
 * fois, et un cadre de livre ne se photographie pas. Chaque animation est donc en deux temps : la page
 * actuelle s'en va, la page tourne pendant qu'elle est invisible (ou de profil), la nouvelle arrive.
 * Seuls `transform` et `opacity` bougent, sur l'élément qui porte tout le livre : le compositeur du
 * navigateur s'en charge, la page ne se recompose pas pendant l'animation — ce qui tient les 60 images
 * par seconde d'un iPhone.
 *
 * L'élément qui tourne est celui que foliate-js mesure : il le fait par sa boîte de mise en page, que les
 * transformations ne changent pas (`layoutRect`, correctif local de `paginator.js`). Avant, il lisait la
 * boîte dessinée — presque 0 px de large quand la page 3D passe de profil — et un chapitre posé à ce
 * moment sortait en colonnes d'un mot (iPhone, 29/10/2026).
 *
 * `slide` est l'exception : à l'intérieur d'un chapitre, c'est foliate-js qui fait glisser ses colonnes
 * (attribut `animated`), un vrai glissement continu ; au passage d'un chapitre au suivant, que foliate-js
 * pose sans transition, la nouvelle page entre en glissant.
 */

export type TurnSide = "left" | "right";

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Joue une animation et rend la main à sa fin — ou tout de suite si le navigateur n'en joue pas (onglet caché). */
async function play(el: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): Promise<Animation | null> {
  if (typeof el.animate !== "function") return null;
  const animation = el.animate(frames, { fill: "forwards", ...options });
  try {
    await animation.finished;
  } catch {
    /* annulée : rien à attendre */
  }
  return animation;
}

/**
 * Tourne la page avec l'animation choisie. `go` tourne vraiment (foliate-js) ; `changedSection` dit
 * après coup si l'on a changé de chapitre. `shade` est un voile sur la page, assombri pendant le
 * retournement en 3D.
 */
export async function turnPage(
  kind: ReaderTurn,
  host: HTMLElement,
  shade: HTMLElement | null,
  side: TurnSide,
  go: () => Promise<unknown>,
  changedSection: () => boolean,
): Promise<void> {
  const dir = side === "right" ? 1 : -1;
  if (kind === "none" || kind === "scroll") {
    await go();
    return;
  }
  if (kind === "slide") {
    await go();
    if (changedSection()) {
      const a = await play(host, [{ transform: `translateX(${dir * 14}%)`, opacity: 0.2 }, { transform: "none", opacity: 1 }], { duration: 260, easing: EASE_OUT });
      a?.cancel();
    }
    return;
  }
  if (kind === "fade") {
    const out = await play(host, [{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: "ease-in" });
    await go();
    const back = await play(host, [{ opacity: 0 }, { opacity: 1 }], { duration: 190, easing: "ease-out" });
    out?.cancel();
    back?.cancel();
    return;
  }
  // `flip` : la page pivote autour de son bord comme une feuille sur sa reliure, passe de profil, et la
  // suivante achève le mouvement. Le voile suit l'angle : une page qui se lève prend de l'ombre.
  const origin = dir > 0 ? "left center" : "right center";
  const shadeIn = shade ? play(shade, [{ opacity: 0 }, { opacity: 0.45 }], { duration: 190, easing: "ease-in" }) : null;
  const out = await play(host, [{ transformOrigin: origin, transform: "rotateY(0deg)" }, { transformOrigin: origin, transform: `rotateY(${-dir * 90}deg)` }], { duration: 190, easing: "cubic-bezier(0.55, 0, 0.9, 0.5)" });
  await shadeIn;
  await go();
  const shadeOut = shade ? play(shade, [{ opacity: 0.45 }, { opacity: 0 }], { duration: 260, easing: EASE_OUT }) : null;
  const back = await play(host, [{ transformOrigin: origin, transform: `rotateY(${dir * 90}deg)` }, { transformOrigin: origin, transform: "rotateY(0deg)" }], { duration: 260, easing: EASE_OUT });
  (await shadeOut)?.cancel();
  out?.cancel();
  back?.cancel();
}

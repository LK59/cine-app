/**
 * Se déplacer à la flèche dans une grille dont on ignore le nombre de colonnes.
 *
 * Les écrans du lecteur changent de colonnes avec la largeur — trois sur un téléphone, sept sur un
 * grand écran — et certains sont des listes d'une seule colonne. Compter les colonnes obligerait
 * chaque écran à déclarer sa mise en page, et à mentir dès qu'elle change.
 *
 * On lit donc la géométrie réelle. Gauche et droite suivent l'ordre du document, en restant sur la
 * même rangée visuelle ; haut et bas cherchent, dans la rangée d'à côté, l'élément dont le centre
 * est le plus proche horizontalement. Ça marche sur une grille, sur une liste, et sur une grille
 * dont la dernière rangée est incomplète.
 *
 * Sans DOM ici : ce sont des rectangles et de l'arithmétique, et ça se vérifie ligne à ligne.
 */

export interface NavRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/**
 * Deux éléments sont sur la même rangée si leurs bandes verticales se recouvrent pour de bon.
 *
 * Pas une égalité de `top` : deux cartes d'une même rangée diffèrent de quelques pixels dès qu'un
 * titre passe sur deux lignes, et une comparaison stricte les mettrait sur des rangées séparées.
 */
function sameRow(a: NavRect, b: NavRect): boolean {
  const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return overlap > Math.min(a.height, b.height) / 2;
}

function centerX(r: NavRect): number {
  return r.left + r.width / 2;
}

/**
 * Où va le focus, ou `null` s'il ne bouge pas.
 *
 * Rendre `null` compte autant que le reste : c'est ce qui laisse la touche à la page — le
 * défilement au bord d'une grille, la sortie vers le rail à gauche — au lieu de l'absorber pour
 * ne rien faire.
 */
export function chooseNext(rects: NavRect[], current: number, key: ArrowKey): number | null {
  if (rects.length === 0) return null;
  // Rien de focalisé : la première flèche entre dans la grille par son premier élément.
  if (current < 0 || current >= rects.length) return key === "ArrowUp" || key === "ArrowLeft" ? null : 0;

  const from = rects[current];

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const step = key === "ArrowRight" ? 1 : -1;
    const next = current + step;
    if (next < 0 || next >= rects.length) return null;
    // On ne saute pas de rangée à l'horizontale : arriver au bout d'une ligne doit rendre la
    // touche, pas repartir à l'autre bout de la suivante.
    return sameRow(from, rects[next]) ? next : null;
  }

  const wanted = centerX(from);
  const below = key === "ArrowDown";
  let best: number | null = null;
  let bestDistance = Infinity;
  let bestEdge = below ? Infinity : -Infinity;

  for (let i = 0; i < rects.length; i++) {
    const candidate = rects[i];
    if (sameRow(from, candidate)) continue;
    const isBelow = candidate.top > from.top;
    if (below !== isBelow) continue;

    // La rangée immédiatement voisine, et elle seule : sur une grille, deux rangées plus bas ne
    // doit jamais gagner parce qu'elle est mieux alignée.
    if (below ? candidate.top > bestEdge : candidate.top < bestEdge) continue;
    const distance = Math.abs(centerX(candidate) - wanted);
    if (below ? candidate.top < bestEdge : candidate.top > bestEdge) {
      bestEdge = candidate.top;
      best = i;
      bestDistance = distance;
      continue;
    }
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

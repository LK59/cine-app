/**
 * Reconnaître une image HDR que le navigateur a aplatie, en la comparant à sa version juste.
 *
 * Le problème : certains navigateurs — Firefox sous Linux notamment — envoient les valeurs
 * BT.2020/PQ d'un film HDR à un écran standard sans les convertir. L'image sort grise, sans noirs
 * ni blancs, désaturée. Aucune API ne permet de demander à un navigateur s'il a fait le travail,
 * et l'image qu'il nous rend est déjà aplatie et ramenée à 8 bits : il n'y a rien à convertir.
 *
 * Mais il y a une référence sous la main. Les vignettes de survol de la barre de progression sont
 * produites par ffmpeg à partir du master, correctement converties. Comparer l'image du lecteur à
 * la vignette du même instant, c'est comparer deux versions de la même image — le contenu sort de
 * l'équation, et il ne reste que la différence de rendu.
 *
 * Ce module ne fait que les mathématiques, sur des pixels qu'on lui donne. Rien ici ne connaît le
 * DOM, ce qui le rend vérifiable ligne à ligne — voir les tests.
 */

/** Ce qu'on mesure d'une image. Trois nombres, choisis parce que c'est ce que l'aplatissement change. */
export interface Look {
  /** Le noir réel de l'image : 5ᵉ centile de luminance, en 0–1. Monte quand rien n'est converti. */
  floor: number;
  /** Le blanc réel : 95ᵉ centile. Descend quand rien n'est converti. */
  ceiling: number;
  /** Saturation moyenne, en 0–1. Des primaires larges rendues sur des étroites ternissent. */
  saturation: number;
}

/** L'empreinte de structure : une grille de luminance normalisée, pour reconnaître le même plan. */
export type Shape = number[];

export interface Sample {
  look: Look;
  shape: Shape;
}

const GRID_W = 8;
const GRID_H = 5;

/**
 * Mesurer une image RGBA.
 *
 * Le centre seulement — 70 % de la largeur et de la hauteur. Les bords portent les bandes noires
 * du format large, identiques dans les deux images et assez massives pour écraser le plancher de
 * noir à zéro des deux côtés, ce qui effacerait justement la différence qu'on cherche.
 */
export function measure(data: Uint8ClampedArray, width: number, height: number): Sample {
  const x0 = Math.floor(width * 0.15);
  const x1 = Math.max(x0 + 1, Math.ceil(width * 0.85));
  const y0 = Math.floor(height * 0.15);
  const y1 = Math.max(y0 + 1, Math.ceil(height * 0.85));

  const lumas: number[] = [];
  let saturationSum = 0;
  const cells = new Float64Array(GRID_W * GRID_H);
  const counts = new Float64Array(GRID_W * GRID_H);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumas.push(luma);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      saturationSum += max === 0 ? 0 : (max - min) / max;

      const cx = Math.min(GRID_W - 1, Math.floor(((x - x0) / (x1 - x0)) * GRID_W));
      const cy = Math.min(GRID_H - 1, Math.floor(((y - y0) / (y1 - y0)) * GRID_H));
      cells[cy * GRID_W + cx] += luma;
      counts[cy * GRID_W + cx] += 1;
    }
  }

  lumas.sort((a, b) => a - b);
  const at = (q: number) => lumas[Math.min(lumas.length - 1, Math.floor(q * lumas.length))] ?? 0;

  return {
    look: { floor: at(0.05), ceiling: at(0.95), saturation: saturationSum / lumas.length },
    shape: normalise(Array.from(cells, (sum, i) => (counts[i] ? sum / counts[i] : 0))),
  };
}

/**
 * La grille, centrée et mise à l'échelle de sa propre dispersion.
 *
 * C'est ce qui permet de reconnaître deux versions d'un même plan malgré la différence de rendu :
 * l'aplatissement change les niveaux — donc la moyenne et l'écart — mais laisse la structure
 * intacte. Une fois centrée-réduite, il ne reste que « où est le clair, où est le sombre ».
 */
function normalise(cells: number[]): Shape {
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  const variance = cells.reduce((a, b) => a + (b - mean) ** 2, 0) / cells.length;
  const deviation = Math.sqrt(variance);
  if (deviation < 1e-6) return cells.map(() => 0);
  return cells.map((c) => (c - mean) / deviation);
}

/** Distance entre deux empreintes. Au-delà du seuil, ce ne sont pas les deux mêmes plans. */
export function shapeDistance(a: Shape, b: Shape): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Au-delà de quoi les deux images ne montrent pas la même chose.
 *
 * Une vignette est prise à l'instant pile du repère ; l'image du lecteur est prise au plus près,
 * mais un plan peut avoir changé entre les deux. Comparer deux plans différents ne dit rien sur
 * le rendu, donc l'échantillon est jeté plutôt qu'interprété. Le seuil est large : deux versions
 * du même plan, l'une compressée en JPEG et réduite, restent très proches une fois normalisées.
 */
export const SAME_SHOT_DISTANCE = 0.55;

/**
 * De combien l'image doit être plus plate que la référence pour que ce soit un défaut de rendu.
 *
 * Généreux, et volontairement. Une image délavée par le PQ non converti ne l'est pas de quelques
 * pour cent : sur la comparaison Chrome/Firefox observée, les noirs montent d'un tiers de
 * l'échelle. Exiger une marge que seul le vrai défaut atteint est ce qui rend le faux positif
 * improbable — et se tromper dans l'autre sens ne coûte que le statu quo.
 */
export const FLATNESS_MARGIN = 0.08;

/** Verdict d'un échantillon : l'image est-elle nettement plus plate que sa référence. */
export function looksFlattened(frame: Look, reference: Look): boolean {
  const floorLifted = frame.floor - reference.floor > FLATNESS_MARGIN;
  const ceilingLowered = reference.ceiling - frame.ceiling > FLATNESS_MARGIN;
  // Les deux, et pas l'un ou l'autre : une image simplement plus claire monte son plancher sans
  // baisser son plafond, et ce n'est pas le défaut qu'on cherche. Le PQ non converti fait les
  // deux à la fois, par construction — toute l'échelle est tassée vers le milieu.
  return floorLifted && ceilingLowered;
}

export type Verdict = "flattened" | "faithful" | "undecided";

/**
 * Combien d'échantillons concordants avant de conclure.
 *
 * Trois, tous du même avis. Un seul plan peut être trompeur ; trois plans pris à des minutes
 * d'intervalle et tous plus plats que leur référence ne le sont pas.
 */
export const REQUIRED_SAMPLES = 3;

export function verdictOf(results: boolean[]): Verdict {
  if (results.length < REQUIRED_SAMPLES) return "undecided";
  if (results.every((flat) => flat)) return "flattened";
  if (results.every((flat) => !flat)) return "faithful";
  // Des avis partagés ne concluent pas. C'est le cas d'un contenu ou d'un appariement douteux, et
  // le silence y vaut mieux qu'une bascule sur une majorité.
  return "undecided";
}

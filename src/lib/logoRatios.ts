/**
 * Les proportions des logos déjà mesurées, gardées d'une fiche à l'autre (`CinemaLogo`).
 *
 * La hauteur d'un logo dépend de sa forme, et sa forme ne se connaît qu'une fois l'image chargée :
 * la première fois, il s'affichait donc à la hauteur par défaut puis se corrigeait sous les yeux. Il
 * reste caché tant qu'elle n'est pas connue ; une image déjà vue — c'est le cas dès qu'on repasse sur
 * un titre — paraît d'emblée.
 */
const KNOWN_RATIOS = new Map<string, number>();

export function knownLogoRatio(src: string): number | null {
  return KNOWN_RATIOS.get(src) ?? null;
}

export function rememberLogoRatio(src: string, ratio: number): void {
  KNOWN_RATIOS.set(src, ratio);
}

/**
 * Le logo d'une fiche, téléchargé dès l'appui sur son affiche, et sa forme notée dès qu'il arrive
 * (15/10/2026) : à la première ouverture d'une fiche, il paraissait un instant après la bannière —
 * la fiche ne pouvait le montrer qu'après l'avoir chargé et mesuré elle-même. L'appui précède
 * l'ouverture de 100 à 300 ms, et le contenu de la fiche ne paraît qu'en fin de trajet : le plus
 * souvent, la forme est connue avant. Sinon, rien ne change — la fiche le mesure à son arrivée.
 */
export function prefetchLogo(src: string | null | undefined): void {
  if (!src || typeof Image === "undefined" || KNOWN_RATIOS.has(src)) return;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    if (img.naturalHeight > 0) KNOWN_RATIOS.set(src, img.naturalWidth / img.naturalHeight);
  };
  img.src = src;
}

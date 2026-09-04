"use client";

import { useEffect, useState } from "react";

/**
 * Le logo d'un titre, à une taille qui ne dépend pas de la forme du logo.
 *
 * Chacun des cinq endroits qui en affichait un plafonnait sa hauteur et sa largeur, ce qui
 * paraît raisonnable et ne l'est pas : ces images n'ont aucune proportion commune. « SUNSHINE »
 * tient sur une ligne — plafonné en hauteur, il reste bas et s'étale, donc c'est la largeur qui
 * l'arrête. « CASINO ROYALE » est empilé sur deux lignes — il atteint le plafond de hauteur tout
 * de suite et se retrouve deux fois plus petit à l'œil, alors que la règle appliquée est la
 * même. D'où la sensation, juste, que les tailles ne sont pas constantes.
 *
 * La hauteur est donc corrigée par la proportion de l'image, mesurée au chargement : plus un
 * logo est long, moins il a besoin de hauteur pour peser autant. Ce que l'on égalise n'est pas
 * une dimension, c'est l'encombrement apparent.
 */

/**
 * Les proportions rencontrées, et ce qu'elles valent en hauteur relative.
 *
 * L'écart entre les extrêmes reste ce qui égalise l'encombrement apparent ; c'est le niveau
 * général qui était trop bas — corriger la hauteur d'un logo long revenait à rapetisser tout le
 * monde, puisque le plafond de base était celui d'un logo carré.
 */
function heightFactor(ratio: number | null): number {
  if (ratio === null) return 1;
  if (ratio >= 5.5) return 0.78; // une ligne très longue : « MISSION: IMPOSSIBLE »
  if (ratio >= 3.5) return 0.9; // une ligne ordinaire : « SUNSHINE »
  if (ratio >= 2) return 1.05; // un mot large ou deux lignes courtes
  // Empilé ou presque carré : « CASINO ROYALE », « Le Parrain ». Ces images-là portent souvent
  // une marge transparente autour du dessin, donc la hauteur mesurée est plus grande que la
  // marque visible : sans ce supplément, elles paraissent petites à hauteur égale.
  return 1.4;
}

/** Les trois surfaces qui portent un logo, et la hauteur qu'elles lui accordent. */
const SURFACES = {
  /** La bannière du haut, sur l'écran de parcours. */
  hero: { compact: 76, roomy: 132, maxWidth: "min(100%, 42rem)" },
  /** La fiche plein écran. */
  sheet: { compact: 68, roomy: 120, maxWidth: "min(100%, 32rem)" },
  /** Le téléphone, où la place est comptée dans les deux sens. */
  phone: { compact: 52, roomy: 76, maxWidth: "min(100%, 21rem)" },
} as const;

/** En dessous, la fenêtre est trop courte pour la hauteur généreuse. */
const ROOMY_FROM = 760;

export function CinemaLogo({
  src,
  alt,
  surface,
  className = "",
  onError,
}: {
  src: string;
  alt: string;
  surface: keyof typeof SURFACES;
  className?: string;
  onError?: () => void;
}) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [roomy, setRoomy] = useState(true);

  useEffect(() => {
    const measure = () => setRoomy(window.innerHeight >= ROOMY_FROM);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const { compact, roomy: tall, maxWidth } = SURFACES[surface];
  const maxHeight = (roomy ? tall : compact) * heightFactor(ratio);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={onError}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalHeight > 0) setRatio(img.naturalWidth / img.naturalHeight);
      }}
      style={{ maxHeight, maxWidth, filter: "drop-shadow(0 6px 20px rgb(0 0 0 / 0.6))" }}
      /**
       * `self-start` : sans lui, l'image s'étirait à la largeur de sa colonne.
       *
       * Ces logos vivent dans un `flex flex-col`, dont l'alignement par défaut est `stretch` :
       * une image y prend toute la largeur disponible, et `object-contain` centre alors le
       * dessin à l'intérieur de cette boîte. D'où « le Parrain » décalé de trois cents pixels
       * vers la droite, alors que le texte sous lui commençait au bord — et d'où l'impression
       * qu'il était petit, puisque seule sa hauteur le limitait dans une boîte trop large.
       * Un appelant qui veut le centrer passe `mx-auto`, dont les marges automatiques
       * l'emportent sur cet alignement.
       */
      className={`w-auto self-start object-contain ${className}`}
    />
  );
}

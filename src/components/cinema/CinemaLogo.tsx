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
  if (ratio >= 5.5) return 0.72; // une ligne très longue : « MISSION: IMPOSSIBLE »
  if (ratio >= 3.5) return 0.85; // une ligne ordinaire : « SUNSHINE »
  if (ratio >= 2) return 1; // un mot large ou deux lignes courtes
  return 1.25; // empilé ou presque carré : « CASINO ROYALE »
}

/** Les trois surfaces qui portent un logo, et la hauteur qu'elles lui accordent. */
const SURFACES = {
  /** La bannière du haut, sur l'écran de parcours. */
  hero: { compact: 72, roomy: 124, maxWidth: "min(100%, 40rem)" },
  /** La fiche plein écran. */
  sheet: { compact: 64, roomy: 112, maxWidth: "min(100%, 30rem)" },
  /** Le téléphone, où la place est comptée dans les deux sens. */
  phone: { compact: 48, roomy: 68, maxWidth: "min(100%, 20rem)" },
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
      className={`w-auto object-contain ${className}`}
    />
  );
}

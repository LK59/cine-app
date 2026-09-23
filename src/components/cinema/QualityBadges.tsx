"use client";

import { qualityBadges, type VideoQuality } from "@/lib/videoQuality";

/**
 * Les étiquettes de qualité, à côté de l'année et de la durée.
 *
 * Un seul composant pour les cinq endroits qui décrivent un titre — deux bannières, deux fiches et
 * la fiche mobile. Cinq copies d'une même liste finiraient par ne plus dire la même chose du même
 * film selon l'écran où on le regarde.
 *
 * Ce qu'on n'y met pas compte autant que ce qu'on y met : rien pour le 1080p, qui est la moitié de
 * cette bibliothèque et ne distingue donc rien, et rien sur l'audio, que le lecteur ré-encode —
 * voir `videoQuality`.
 *
 * **Des pastilles nues, à poser dans une rangée.** Le fragment est délibéré : les quatre appelants
 * les mêlent à d'autres informations — la note, la durée, les genres — et un conteneur imposé ici
 * casserait cet alignement. Le prix est qu'une colonne flex les étire chacune sur toute sa
 * largeur, ce qui est arrivé une fois, sur la bannière du téléphone en paysage.
 */
export function QualityBadges({ quality, className = "" }: { quality: VideoQuality | null | undefined; className?: string }) {
  const badges = qualityBadges(quality);
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <span
          key={badge}
          className={`rounded border border-white/25 px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-muted ${className}`}
        >
          {badge}
        </span>
      ))}
    </>
  );
}

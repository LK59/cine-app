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
 */
export function QualityBadges({ quality, className = "" }: { quality: VideoQuality | null | undefined; className?: string }) {
  const badges = qualityBadges(quality);
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <span
          key={badge}
          className={`rounded border border-white/25 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white/80 ${className}`}
        >
          {badge}
        </span>
      ))}
    </>
  );
}

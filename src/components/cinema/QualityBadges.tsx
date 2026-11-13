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
export function QualityBadges({
  quality,
  className = "",
  onOpen,
  openLabel,
}: {
  quality: VideoQuality | null | undefined;
  className?: string;
  /**
   * Touchée, une pastille ouvre la fenêtre « Détails » du film (DECISIONS.md §152, 13/11/2026). **Fiches de
   * films seulement** : les bannières de l'accueil, les fiches de séries et la fiche d'un lien de partage ne la
   * passent pas, et leurs pastilles restent du texte. La zone de toucher est la pastille elle-même, sans marge
   * élargie : posée dans la ligne d'infos, à côté de l'année et de la durée, une cible plus grande s'ouvrait
   * au moindre défilement du doigt.
   */
  onOpen?: () => void;
  /** Le nom de ce que la pastille ouvre, pour les lecteurs d'écran (« Détails »). */
  openLabel?: string;
}) {
  const badges = qualityBadges(quality);
  if (badges.length === 0) return null;
  const look = `rounded border border-white/25 px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-muted ${className}`;
  return (
    <>
      {badges.map((badge) =>
        onOpen ? (
          <button
            key={badge}
            type="button"
            data-quality-open=""
            onClick={onOpen}
            aria-label={openLabel ? `${badge} — ${openLabel}` : badge}
            className={`${look} cursor-pointer transition-colors hover:border-white/50 hover:text-white focus-visible:border-white focus-visible:text-white focus-visible:outline-none`}
          >
            {badge}
          </button>
        ) : (
          <span key={badge} className={look}>
            {badge}
          </span>
        )
      )}
    </>
  );
}

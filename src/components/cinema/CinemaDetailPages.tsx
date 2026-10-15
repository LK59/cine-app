"use client";

import { useState, type ReactNode } from "react";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { guidedScrollClass, useGuidedScroll } from "@/lib/guidedScroll";
import { useT } from "@/components/TranslationProvider";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { CinemaScrollHint } from "@/components/cinema/CinemaScrollHint";
import type { CinemaCastMember } from "@/components/cinema/CinemaCastRow";
import { CAST_CLASS, CAST_SHOWN, SECTION_CLASS, BELOW_SECTION_CLASS, CinemaDetailModal } from "@/components/cinema/CinemaDetailLayout";

/**
 * Les pièces d'une fiche du bureau qui ne dépendent pas de ce qu'elle montre : les deux pages, le
 * nom du titre, la ligne de distribution (DECISIONS.md §61, note du 14/10/2026).
 *
 * Le film et la série les écrivaient chacun, à l'identique ; la fiche découverte (titre absent de
 * la bibliothèque, ouverte pour « Demander ») avait sa propre version, et elle avait dérivé : une
 * seule page au lieu de deux, la rangée de visages *dans* la colonne du premier écran. Ce premier
 * écran est `h-full overflow-hidden justify-end` — il tient dans la fenêtre et se cale en bas —,
 * donc une colonne trop haute déborde par le haut : le titre de « Matchbox – Le film » se dessinait
 * sous le bouton Retour (capture de Louis, 14/10/2026). Une seule écriture désormais pour les trois.
 */

/**
 * Le défilement à deux pages : l'en-tête plein écran, puis — s'il y a quelque chose à montrer —
 * la distribution, la saga et les titres similaires, avec le rappel de défilement au pied du
 * premier.
 *
 * `justify-end` dans une section `h-full`, jamais `items-end` sur le défileur : un conteneur flex
 * aligné à sa fin rogne ce qui dépasse par son début et le rend inatteignable au défilement — c'est
 * ce qui avait poussé le logo hors de l'écran quand la rangée des similaires est arrivée ici.
 */
export function CinemaDetailPages({ first, below }: { first: ReactNode; below?: ReactNode }) {
  // Le calage sur une page entière, réglable par compte (`guidedScroll.ts`, DECISIONS.md §50).
  const guided = useGuidedScroll();
  const hasBelow = below !== undefined && below !== null && below !== false;
  return (
    <div data-detail-pages="" className={`scrollbar-thin relative h-full ${guidedScrollClass(guided)} overflow-y-auto scroll-smooth`}>
      <div data-snap-section className={SECTION_CLASS}>
        {first}
        {hasBelow && <CinemaScrollHint />}
      </div>
      {hasBelow && (
        <div data-snap-section className={BELOW_SECTION_CLASS}>
          {below}
        </div>
      )}
    </div>
  );
}

const TITLE_CLASS = "text-2xl font-bold leading-tight text-white drop-shadow-lg sm:text-4xl font-display";

/** Le nom du titre en tête de colonne : son logo quand il en a un, le titre écrit sinon. */
/**
 * Le nom du titre en tête d'une fiche du téléphone — bibliothèque et découverte (15/10/2026) : son
 * logo, ou le titre écrit quand il n'en a pas (ou qu'il ne vient pas). La fiche découverte du
 * téléphone n'écrivait que le titre depuis sa création (05/09/2026).
 */
export function PhoneSheetTitle({ title, logoUrl }: { title: string; logoUrl: string | null | undefined }) {
  const written = <h1 className="mb-3 font-display text-2xl font-bold leading-tight text-white">{title}</h1>;
  if (!logoUrl) return written;
  return <CinemaLogo src={logoUrl} alt={title} surface="phone" shadow={false} className="mb-3 object-left" fallback={written} />;
}

export function CinemaDetailTitle({ title, logoUrl }: { title: string; logoUrl: string | null | undefined }) {
  const written = <h1 className={TITLE_CLASS}>{title}</h1>;
  if (!logoUrl) return written;
  return <CinemaLogo src={logoUrl} alt={title} surface="sheet" className="mb-1" fallback={written} />;
}

/**
 * « Avec » et trois noms entiers, puis un décompte qui ouvre la liste complète.
 *
 * Chaque nom mène à sa fiche, sans quitter le lecteur. Volontairement hors du parcours des flèches
 * (pas de `data-detail-menu`) : y intercaler cinq noms ferait descendre de six crans pour atteindre
 * l'action suivante. La tabulation, elle, y va.
 *
 * Trois noms et un nombre plutôt qu'une coupure au pixel : `truncate` tranchait au milieu d'un nom
 * en laissant la virgule précédente pendre dans le vide. Le décompte est hors du paragraphe
 * tronqué, parce que c'est le seul élément qu'on ne peut pas se permettre de perdre.
 */
export function CinemaDetailCastLine({ cast, className = "" }: { cast: CinemaCastMember[]; className?: string }) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  if (cast.length === 0) return null;
  return (
    <>
      <div className={`flex items-baseline gap-1.5 ${className}`}>
        <p className={CAST_CLASS}>
          {t("cinema.cast")}{" "}
          {cast.slice(0, CAST_SHOWN).map((c, i) => (
            <span key={c.tmdbId}>
              {i > 0 && ", "}
              <button
                type="button"
                onClick={() => cinemaNavigate({ person: c.tmdbId })}
                className="rounded transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
              >
                {c.name}
              </button>
            </span>
          ))}
        </p>
        {cast.length > CAST_SHOWN && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="shrink-0 rounded text-xs font-medium text-muted transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
          >
            +{cast.length - CAST_SHOWN}
          </button>
        )}
      </div>

      {showAll && (
        <CinemaDetailModal title={t("cinema.castTitle")} closeLabel={t("common.close")} onClose={() => setShowAll(false)}>
          {/* La même fenêtre que le synopsis, et chaque nom y reste une porte vers sa filmographie.
              Fermer d'abord, naviguer ensuite : laisser la fenêtre ouverte par-dessus la fiche qu'on
              vient de quitter serait un écran de trop. */}
          <ul className="flex flex-col gap-1">
            {cast.map((c) => (
              <li key={c.tmdbId}>
                <button
                  type="button"
                  onClick={() => {
                    setShowAll(false);
                    cinemaNavigate({ person: c.tmdbId });
                  }}
                  className="rounded text-left transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
                >
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </CinemaDetailModal>
      )}
    </>
  );
}

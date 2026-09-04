"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * La première rangée : celle que la bannière suit.
 *
 * Il y avait bien une rotation en haut de l'écran — huit titres qui se relayaient toutes les
 * quelques secondes — mais nulle part dans la page : aucune carte, aucun repère, rien dans la
 * grille de navigation. On voyait passer des films sans pouvoir en désigner un, encore moins
 * l'ouvrir. C'était un décor, pas une section.
 *
 * Ici les mêmes titres sont des cartes comme les autres — donc atteignables aux flèches,
 * survolables, cliquables — et la bannière montre celui qui est désigné. La rotation continue de
 * tourner tant que personne n'a pris la main ; les barres disent où l'on en est et permettent
 * d'aller directement à l'un d'eux.
 */
export function CinemaSpotlight({
  label,
  count,
  activeIndex,
  onPick,
  children,
}: {
  label: string;
  count: number;
  activeIndex: number;
  /** Aller directement à ce titre : la bannière le montre, la rangée s'y amène. */
  onPick: (index: number) => void;
  children: ReactNode;
}) {
  const rail = useRef<HTMLDivElement>(null);

  // La rangée suit la rotation. Sans cela, la bannière annoncerait au bout de quelques tours un
  // titre dont la carte est sortie de l'écran par la gauche — la section dirait alors le
  // contraire de ce qu'elle montre.
  useEffect(() => {
    // -1 : la bannière montre un titre qui n'est pas dans cette rangée (une carte désignée plus
    // bas). Rien à amener sous les yeux, et rien à allumer.
    if (activeIndex < 0) return;
    const track = rail.current;
    const card = track?.children[activeIndex] as HTMLElement | undefined;
    if (!track || !card) return;
    // `scrollLeft` et non `scrollIntoView` : celui-ci fait défiler *tous* les ancêtres qui en ont
    // besoin, y compris le panneau vertical — la rotation déplaçait donc la page sous les pieds
    // de qui parcourait les rangées plus bas. Ici seul ce rail bouge, sur son seul axe.
    track.scrollTo({
      left: card.offsetLeft - (track.clientWidth - card.clientWidth) / 2,
      behavior: "smooth",
    });
  }, [activeIndex]);

  if (count === 0) return null;

  return (
    <div data-tv-rowroot className="mb-6 animate-fade-in-up snap-start">
      <div className="mb-2 flex items-center gap-4 px-8 sm:px-12">
        <h2 className="text-sm font-medium text-white/70">{label}</h2>
        {/* Des barres, pas des points : elles disent aussi la place occupée dans la série, et
            elles offrent une cible qu'un doigt ou un curseur atteint sans viser. */}
        <div className="flex items-center gap-1.5">
          {Array.from({ length: count }).map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`${label} ${i + 1}/${count}`}
              aria-current={i === activeIndex}
              onClick={() => onPick(i)}
              className="group -my-2 py-2"
            >
              <span
                className={`block h-[3px] rounded-full transition-all duration-300 group-hover:bg-white ${
                  i === activeIndex ? "w-6 bg-white" : "w-3 bg-white/30"
                }`}
              />
            </button>
          ))}
        </div>
      </div>
      {/* Même gouttière et mêmes marges que les autres rangées : cette section est distincte par
          ce qu'elle fait, pas par une géométrie à elle. */}
      <div
        ref={rail}
        className="scrollbar-thin flex scroll-smooth gap-3 overflow-x-auto overflow-y-hidden px-8 pb-4 pt-3 sm:px-12"
        style={{
          maskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
          WebkitMaskImage: "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

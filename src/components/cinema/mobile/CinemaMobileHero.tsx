"use client";

import { memo, useRef, useState } from "react";
import { Info, Play } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { useRotatingIndex } from "@/lib/useRotatingIndex";
import { useCarouselDrag, carouselTransform, CAROUSEL_TRANSITION } from "@/lib/useCarouselDrag";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

type Item = CinemaMovie | CinemaSeries;

/**
 * La bannière du téléphone, avec son propre index.
 *
 * Elle vivait dans l'écran d'accueil, dont elle partageait l'état : changer de titre — au doigt
 * comme à la rotation — redessinait donc tout, ses six rangées et leurs affiches comprises. Ça se
 * voyait au relâchement, où ce travail tombait sur les premières images de l'animation.
 *
 * L'index est ici, et le composant est mémoïsé : un changement de titre ne redessine que la
 * bannière — trois affiches et une rangée de barres.
 */
export const CinemaMobileHero = memo(function CinemaMobileHero({
  items,
  paused,
  short,
  onPlay,
  onOpen,
}: {
  items: Item[];
  /** La rotation s'arrête quand une fiche ou la recherche est ouverte par-dessus. */
  paused: boolean;
  /** Écran couché : l'affiche passe à côté du texte au lieu d'être derrière. */
  short: boolean;
  onPlay: (item: Item) => void;
  onOpen: (item: Item) => void;
}) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [index, setIndex] = useRotatingIndex(items.length, paused || dragging);
  const drag = useCarouselDrag({
    trackRef,
    count: items.length,
    index,
    onIndexChange: setIndex,
    onDragStateChange: setDragging,
  });

  if (items.length === 0) return null;

  const actions = (item: Item) => (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => onPlay(item)}
        className="flex flex-1 items-center justify-center gap-2 rounded-md bg-white px-3 py-2.5 text-sm font-semibold text-ink transition-transform active:scale-95"
      >
        <Play size={16} fill="currentColor" />
        {t("common.play")}
      </button>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex flex-1 items-center justify-center gap-2 rounded-md bg-white/15 px-3 py-2.5 text-sm font-medium text-white transition-transform active:scale-95"
      >
        <Info size={16} />
        {t("cinema.moreInfo")}
      </button>
    </div>
  );

  return (
    <section className="px-4 pt-2">
      {/* Une piste, et non une affiche remplacée : toutes les affiches sont côte à côte et la
          piste est décalée d'une largeur par titre. Pendant le geste elle porte en plus le
          décalage du doigt, sans transition — elle n'anime pas vers une cible, elle est là où le
          doigt l'a mise. Voir useCarouselDrag pour le relâchement. */}
      <div className="overflow-hidden rounded-2xl" {...drag.handlers} style={drag.style}>
        <div
          ref={trackRef}
          className="flex"
          style={{
            transform: carouselTransform(index),
            transition: CAROUSEL_TRANSITION,
            // Promue une fois pour toutes, plutôt qu'à chaque geste : sans cela le navigateur
            // décide de promouvoir la piste au premier déplacement, ce qui veut dire re-tramer
            // une surface de plusieurs écrans de large au moment où le doigt attend une réponse.
            willChange: "transform",
          }}
        >
          {items.map((item, i) => (
            <div key={"radarrId" in item ? `f${item.radarrId}` : `s${item.sonarrId}`} className="w-full shrink-0">
              {/* Seules l'affiche courante et ses deux voisines existent : les huit rendues
                  ensemble font une piste de huit écrans de large à tramer et à garder en
                  mémoire, plus huit logos. Trois suffisent — celle qu'on voit, celle d'où l'on
                  vient, celle où l'on va. */}
              {Math.abs(i - index) > 1 ? null : short ? (
                <div className="flex gap-4 rounded-2xl bg-slate-900/70 p-3 shadow-xl shadow-black/50">
                  <div className="w-24 shrink-0 overflow-hidden rounded-lg">
                    <PosterImage src={item.posterUrl} alt={item.title} subtle unoptimized priority={i === index} sizes="120px" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col justify-center">
                    {item.logoUrl ? (
                      <CinemaLogo src={item.logoUrl} alt={item.title} surface="phone" className="mb-2 self-start" />
                    ) : (
                      <h1 className="mb-2 truncate text-xl font-bold text-white drop-shadow-lg">{item.title}</h1>
                    )}
                    {item.genres.length > 0 && (
                      <p className="mb-3 truncate text-xs text-white/70">{item.genres.slice(0, 3).join(" · ")}</p>
                    )}
                    {actions(item)}
                  </div>
                </div>
              ) : (
                <div className="relative overflow-hidden rounded-2xl bg-slate-900 shadow-xl shadow-black/50">
                  <PosterImage src={item.posterUrl} alt={item.title} subtle unoptimized priority={i === index} sizes="100vw" />
                  <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-ink via-ink/70 to-transparent p-4 pt-16">
                    {item.logoUrl ? (
                      <CinemaLogo src={item.logoUrl} alt={item.title} surface="phone" className="mx-auto mb-2" />
                    ) : (
                      <h1 className="mb-2 text-center text-2xl font-bold text-white drop-shadow-lg font-display">{item.title}</h1>
                    )}
                    {item.genres.length > 0 && (
                      <p className="mb-3 text-center text-xs text-white/70">{item.genres.slice(0, 3).join(" · ")}</p>
                    )}
                    {actions(item)}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Hors de la piste : les barres disent où l'on en est, elles ne défilent pas avec. */}
      {items.length > 1 && (
        <div className="mx-auto mt-3 flex max-w-xs gap-1">
          {items.map((item, i) => (
            <button
              key={"radarrId" in item ? `f${item.radarrId}` : `s${item.sonarrId}`}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={item.title}
              aria-current={i === index}
              className="h-1 flex-1 overflow-hidden rounded-full bg-white/25"
            >
              {i < index && <div className="h-full w-full bg-white" />}
              {i === index && <div key={index} className="h-full animate-hero-fill bg-white" />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
});

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { PersonAvatar } from "@/components/ask/AskPersonHeader";
import { scrollBehavior } from "@/lib/reducedMotion";
import type { XrayPlayerPerson } from "@/lib/xray/scenes";

/**
 * « À l'écran » (DECISIONS.md §138) : film en pause, au-dessus du titre, à gauche — une petite étiquette,
 * puis une rangée de pilules de verre qui défile de côté, une par personne de la scène (photo ronde, nom
 * de l'acteur, personnage), par temps à l'écran. Au doigt, on la fait glisser (aimantée sur chaque pilule) ;
 * à la souris, la molette ou le pavé, et deux petites flèches (pointeur fin seulement). Un fondu au bord
 * droit dit qu'il y en a d'autres. `trailing` (« Une question ? ») reste au bout, hors de ce qui défile.
 *
 * Une photo absente ou qui ne charge pas montre les initiales — jamais une image cassée.
 *
 * Le fondu des commandes (`player-fade`) est porté par chaque pilule, jamais par la rangée (la règle de
 * globals.css : un parent à opacité < 1 isole le flou). Le fondu du bord droit est un masque, posé
 * seulement quand il y a d'autres pilules à faire venir.
 */
export interface PlayerOnScreenProps {
  people: XrayPlayerPerson[];
  /** Les commandes sont affichées : la rangée paraît et part avec elles. */
  visible: boolean;
  onPick: (person: XrayPlayerPerson) => void;
  trailing?: ReactNode;
}

export function PlayerOnScreen({ people, visible, onPick, trailing }: PlayerOnScreenProps) {
  const t = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ before: false, after: false });

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const before = row.scrollLeft > 2;
    const after = row.scrollLeft + row.clientWidth < row.scrollWidth - 2;
    setEdges((prev) => (prev.before === before && prev.after === after ? prev : { before, after }));
  }, []);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const frame = window.requestAnimationFrame(measure);
    if (typeof ResizeObserver === "undefined") return () => window.cancelAnimationFrame(frame);
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure, people]);

  // La molette verticale d'une souris fait défiler la rangée de côté (un pavé tactile le fait déjà).
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    function onWheel(e: WheelEvent) {
      const r = rowRef.current;
      if (!r || r.scrollWidth <= r.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        r.scrollLeft += e.deltaY;
        e.preventDefault();
      }
      e.stopPropagation();
    }
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => row.removeEventListener("wheel", onWheel);
  }, [people.length]);

  const page = (direction: 1 | -1) => {
    const row = rowRef.current;
    if (!row) return;
    const by = Math.max(120, row.clientWidth * 0.8) * direction;
    if (typeof row.scrollBy === "function") row.scrollBy({ left: by, behavior: scrollBehavior() });
    else row.scrollLeft += by;
  };

  if (people.length === 0 && !trailing) return null;
  const live = visible ? "pointer-events-auto" : "pointer-events-none";

  return (
    <div data-player-onscreen="" className="flex w-full min-w-0 flex-col items-start gap-2">
      {people.length > 0 && (
        <p className="player-fade player-onscreen-label pl-1 text-[11px] font-semibold uppercase leading-none tracking-[.16em] text-white/60">{t("xray.onScreen")}</p>
      )}
      <div className="flex w-full min-w-0 items-center gap-2">
        {people.length > 0 && (
          <div className="relative min-w-0 shrink">
            <div
              ref={rowRef}
              data-onscreen-row=""
              onScroll={measure}
              className={`player-onscreen-row ${edges.after ? "player-onscreen-more" : ""} ${live} flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain`}
            >
              {people.map((person) => (
                <button
                  key={person.personId}
                  type="button"
                  data-onscreen-person={person.personId}
                  data-player-surface-ignore
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(person);
                  }}
                  className="player-fade player-pill player-onscreen-pill flex shrink-0 snap-start items-center gap-2.5 py-1.5 pl-1.5 pr-4 text-left text-white"
                >
                  <PersonAvatar person={person} className="player-onscreen-photo" />
                  <span className="flex min-w-0 flex-col">
                    <span className="player-onscreen-name max-w-[11rem] truncate font-semibold leading-tight">{person.name}</span>
                    {person.character && <span className="player-onscreen-character max-w-[11rem] truncate leading-tight text-white/60">{person.character}</span>}
                  </span>
                </button>
              ))}
            </div>
            {edges.before && (
              <button
                type="button"
                data-onscreen-arrow="previous"
                data-player-surface-ignore
                aria-label={t("xray.previous")}
                onClick={(e) => {
                  e.stopPropagation();
                  page(-1);
                }}
                className={`player-fade player-onscreen-arrow player-pill ${live} absolute left-0 top-1/2 h-8 w-8 -translate-y-1/2 items-center justify-center text-white`}
              >
                <ChevronLeft size={18} aria-hidden />
              </button>
            )}
            {edges.after && (
              <button
                type="button"
                data-onscreen-arrow="next"
                data-player-surface-ignore
                aria-label={t("xray.next")}
                onClick={(e) => {
                  e.stopPropagation();
                  page(1);
                }}
                className={`player-fade player-onscreen-arrow player-pill ${live} absolute right-0 top-1/2 h-8 w-8 -translate-y-1/2 items-center justify-center text-white`}
              >
                <ChevronRight size={18} aria-hidden />
              </button>
            )}
          </div>
        )}
        {trailing}
      </div>
    </div>
  );
}

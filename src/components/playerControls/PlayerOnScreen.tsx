"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { PersonAvatar } from "@/components/ask/AskPersonHeader";
import { scrollBehavior } from "@/lib/reducedMotion";
import type { XrayPlayerPerson } from "@/lib/xray/scenes";

/**
 * « À l'écran » (DECISIONS.md §138) : au-dessus du bloc du titre, à gauche — une petite étiquette, puis une
 * rangée de pilules de verre qui défile de côté, une par personne de la scène (photo ronde, nom de
 * l'acteur, personnage), par temps à l'écran. Au doigt, on la fait glisser (aimantée sur chaque pilule) ;
 * à la souris, la molette ou le pavé, et deux petites flèches (pointeur fin seulement). Un fondu au bord
 * droit dit qu'il y en a d'autres. `trailing` (le bouton rond de la question) reste au bout, hors de ce
 * qui défile.
 *
 * **Avec les commandes, en lecture comme en pause** (10.27) : la rangée suit les changements de scène —
 * les nouveaux visages arrivent en fondu, ceux qui partent s'effacent (`player-onscreen-in` / `-out`) —, mais
 * **jamais sous un doigt** : tant qu'on la touche ou qu'elle défile (et 600 ms après), elle garde ce qu'elle
 * montre, puis rattrape la scène de l'instant.
 *
 * `maxWidth` (10.27) : la largeur permise — elle ne s'arrête avant les boutons du centre ou la pilule des
 * outils que s'ils partagent sa hauteur (`onScreenRowWidth`, 10.27.1), et défile dans ce qui reste. Une
 * pilule n'a pas de largeur à elle (10.27.1 : « Hannah Waddingh… » coupé avec la moitié de l'écran libre) :
 * un nom n'est coupé que si la rangée entière manque de place (`max-w-full`).
 *
 * Une photo absente ou qui ne charge pas montre les initiales — jamais une image cassée. Le fondu des
 * commandes (`player-fade`) est porté par chaque pilule, jamais par la rangée (globals.css : un parent à
 * opacité < 1 isole le flou).
 */
export interface PlayerOnScreenProps {
  people: XrayPlayerPerson[];
  /** Les commandes sont affichées : la rangée paraît et part avec elles. */
  visible: boolean;
  onPick: (person: XrayPlayerPerson) => void;
  trailing?: ReactNode;
  maxWidth?: number | null;
}

/** Après le dernier contact ou le dernier défilement, le temps avant que la rangée suive de nouveau la scène. */
export const ONSCREEN_SETTLE_MS = 600;
/** La durée du fondu d'un changement de scène (`player-onscreen-in` / `-out`, globals.css). */
export const ONSCREEN_FADE_MS = 280;

const signature = (people: readonly XrayPlayerPerson[]) => people.map((p) => p.personId).join(",");

export function PlayerOnScreen({ people, visible, onPick, trailing, maxWidth }: PlayerOnScreenProps) {
  const t = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ before: false, after: false });

  /**
   * Ce que la rangée montre : la scène de l'instant, sauf pendant qu'on la touche ou la fait défiler. Le
   * changement se décide pendant le rendu (l'état d'avant gardé, pas un effet) ; `leaving` garde les pilules
   * parties le temps de leur fondu.
   */
  const [touching, setTouching] = useState(false);
  // `fresh` : les visages arrivés au dernier changement (en fondu) ; ceux de la première image sont déjà là.
  const [shown, setShown] = useState<{ sig: string; list: XrayPlayerPerson[]; leaving: XrayPlayerPerson[]; fresh: number[] }>(() => ({
    sig: signature(people),
    list: people,
    leaving: [],
    fresh: [],
  }));
  const nextSig = signature(people);
  if (!touching && nextSig !== shown.sig) {
    const kept = new Set(people.map((p) => p.personId));
    const before = new Set(shown.list.map((p) => p.personId));
    setShown({
      sig: nextSig,
      list: people,
      leaving: shown.list.filter((p) => !kept.has(p.personId)),
      fresh: people.filter((p) => !before.has(p.personId)).map((p) => p.personId),
    });
  }

  // Les pilules parties s'effacent puis disparaissent.
  useEffect(() => {
    if (!shown.leaving.length) return;
    const timer = window.setTimeout(() => setShown((prev) => (prev.leaving.length ? { ...prev, leaving: [] } : prev)), ONSCREEN_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [shown.leaving]);

  // Le contact : posé au premier appui, au défilement, à la molette ; levé 600 ms après le dernier signe.
  const settleTimer = useRef<number | undefined>(undefined);
  const pointerDown = useRef(false);
  const touchStart = useCallback(() => {
    if (settleTimer.current !== undefined) window.clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
    setTouching(true);
  }, []);
  const touchSettle = useCallback(() => {
    if (pointerDown.current) return;
    if (settleTimer.current !== undefined) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = undefined;
      setTouching(false);
    }, ONSCREEN_SETTLE_MS);
  }, []);
  useEffect(() => () => {
    if (settleTimer.current !== undefined) window.clearTimeout(settleTimer.current);
  }, []);

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
  }, [measure, shown.sig, maxWidth]);

  // La molette verticale d'une souris fait défiler la rangée de côté (un pavé tactile le fait déjà).
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    function onWheel(e: WheelEvent) {
      const r = rowRef.current;
      if (!r || r.scrollWidth <= r.clientWidth) return;
      touchStart();
      touchSettle();
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        r.scrollLeft += e.deltaY;
        e.preventDefault();
      }
      e.stopPropagation();
    }
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => row.removeEventListener("wheel", onWheel);
  }, [shown.list.length, touchStart, touchSettle]);

  const page = (direction: 1 | -1) => {
    const row = rowRef.current;
    if (!row) return;
    const by = Math.max(120, row.clientWidth * 0.8) * direction;
    if (typeof row.scrollBy === "function") row.scrollBy({ left: by, behavior: scrollBehavior() });
    else row.scrollLeft += by;
  };

  const list = shown.list;
  if (list.length === 0 && shown.leaving.length === 0 && !trailing) return null;
  const live = visible ? "pointer-events-auto" : "pointer-events-none";
  const entering = (id: number) => shown.fresh.includes(id);

  const pill = (person: XrayPlayerPerson, leaving: boolean) => (
    <button
      key={`${leaving ? "out" : "in"}:${person.personId}`}
      type="button"
      data-onscreen-person={leaving ? undefined : person.personId}
      data-onscreen-leaving={leaving ? person.personId : undefined}
      data-player-surface-ignore
      tabIndex={leaving ? -1 : undefined}
      aria-hidden={leaving || undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (!leaving) onPick(person);
      }}
      className={`player-fade player-pill player-onscreen-pill flex min-w-0 max-w-full shrink-0 snap-start items-center gap-2 py-1 pl-1 pr-3.5 text-left text-white ${
        leaving ? "player-onscreen-out pointer-events-none" : entering(person.personId) ? "player-onscreen-in" : ""
      }`}
    >
      <PersonAvatar person={person} className="player-onscreen-photo" />
      <span className="flex min-w-0 flex-col">
        <span className="player-onscreen-name truncate font-semibold leading-tight">{person.name}</span>
        {person.character && <span className="player-onscreen-character truncate leading-tight text-white/60">{person.character}</span>}
      </span>
    </button>
  );

  return (
    <div
      data-player-onscreen=""
      className="flex w-full min-w-0 flex-col items-start gap-1.5"
      style={maxWidth != null ? { maxWidth } : undefined}
    >
      {list.length > 0 && (
        <p className="player-fade player-onscreen-label pl-1 text-[11px] font-semibold uppercase leading-none tracking-[.16em] text-white/60">{t("xray.onScreen")}</p>
      )}
      <div data-onscreen-line="" className="flex w-full min-w-0 items-center gap-2">
        {(list.length > 0 || shown.leaving.length > 0) && (
          <div className="relative min-w-0 shrink">
            <div
              ref={rowRef}
              data-onscreen-row=""
              data-onscreen-touching={touching ? "" : undefined}
              onScroll={() => {
                measure();
                if (touching) touchSettle();
              }}
              onPointerDown={() => {
                pointerDown.current = true;
                touchStart();
              }}
              onPointerUp={() => {
                pointerDown.current = false;
                touchSettle();
              }}
              onPointerCancel={() => {
                pointerDown.current = false;
                touchSettle();
              }}
              onTouchStart={() => {
                pointerDown.current = true;
                touchStart();
              }}
              onTouchEnd={() => {
                pointerDown.current = false;
                touchSettle();
              }}
              className={`player-onscreen-row ${edges.after ? "player-onscreen-more" : ""} ${live} flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain`}
            >
              {list.map((person) => pill(person, false))}
              {shown.leaving.map((person) => pill(person, true))}
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

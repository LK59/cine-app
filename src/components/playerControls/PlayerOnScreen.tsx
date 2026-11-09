"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { PersonAvatar } from "@/components/ask/AskPersonHeader";
import { scrollBehavior } from "@/lib/reducedMotion";
import { SOFAR_HOVER_INTENT_MS } from "@/lib/ask/client";

/** Un pointeur fin qui survole (souris, pavé) — jamais un écran tactile, où un survol n'est pas une intention. */
function finePointer(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch {
    return false;
  }
}
import type { XrayPlayerPerson } from "@/lib/xray/scenes";
import { boxOf, lookOf, type XrayUiDiagFn } from "@/lib/xrayUiDiag";

/**
 * « À l'écran » (DECISIONS.md §138) : au-dessus du bloc du titre, à gauche — une petite étiquette, puis une
 * rangée de pilules de verre qui défile de côté, une par personne de la scène (photo ronde, nom de
 * l'acteur, personnage), par temps à l'écran. Au doigt, on la fait glisser (aimantée sur chaque pilule) ;
 * à la souris, la molette ou le pavé, et deux petites flèches (pointeur fin seulement). Un fondu au bord
 * droit dit qu'il y en a d'autres. `trailing` (le bouton rond de la question) reste au bout, hors de ce
 * qui défile.
 *
 * **Le fondu du bord est un voile posé dessus, pas un masque** (10.29.1) : un élément à lui
 * (`data-onscreen-fade`, `.player-onscreen-fade`), sans pointeur, au-dessus des pilules et sous les flèches,
 * monté seulement quand la rangée déborde. Jusqu'en 10.29.0 c'était un `mask-image` sur la rangée qui défile —
 * un parent masqué d'enfants à `backdrop-filter` qui défilent, la combinaison de plusieurs défauts de rendu
 * connus de WebKit (284227, 279115, 298709). Sur l'iPhone du propriétaire, dans une scène qui débordait, des
 * touchers ont fait disparaître la rangée puis l'ont rendue vide, et le panneau d'une personne n'a pas paru ;
 * l'état, rejoué, était juste. Aucun masque sur ce qui porte du verre.
 *
 * **Les pilules répondent au doigt comme les autres pilules du lecteur** (10.29.1) : le geste liquide
 * (`data-liquid-pan="press"`, branché par la délégation de `PlayerControls`) — elles gonflent à l'appui et
 * rebondissent au relâchement ; le doigt qui part de côté rend la main au défilement (`yieldAfter`), et un
 * appui pendant que la rangée défile encore (`data-onscreen-scrolling`, l'élan d'iOS) ne gonfle rien.
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
 * **Elle commence au début** (10.27.2) : à l'ouverture et à chaque changement de scène, la rangée revient à
 * sa première pilule — la personne la plus longtemps à l'écran —, sauf sous un doigt. 10.27.1 s'ouvrait
 * souvent au bout sur l'iPhone : l'aimantation (`snap-mandatory`) garde, après un changement de mise en
 * page, la pilule sur laquelle elle était posée — une pilule déplacée vers la fin d'une nouvelle scène
 * emmenait la rangée avec elle. `toStart` la remet au début après chaque mise en page qui n'est pas le fait
 * de qui regarde (`userMoved` : un doigt, la molette, une flèche).
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
  /**
   * Un doigt, la molette ou une flèche sur la rangée (10.27.2) : les commandes ne doivent pas partir
   * pendant le geste (`holdControls`) ; la fin du geste — `ONSCREEN_SETTLE_MS` après le dernier signe —
   * relance leur décompte (`onRelease`).
   */
  onHold?: () => void;
  onRelease?: () => void;
  /**
   * Une intention sur une pilule (10.27.2) : un pointeur fin qui s'y pose `SOFAR_HOVER_INTENT_MS` — pas un
   * passage, jamais un doigt. Le lecteur y prépare « Jusqu'ici » de cette seule personne (`prewarmSofar`).
   */
  onIntent?: (person: XrayPlayerPerson) => void;
  /** Le relevé `xray-ui` de la séance (10.29.1, `xrayUiDiag.ts`) : la rangée montrée, un toucher. */
  diag?: XrayUiDiagFn;
  /** Le début de la scène montrée, pour ce relevé. */
  sceneStart?: number | null;
}

/** Après le dernier contact ou le dernier défilement, le temps avant que la rangée suive de nouveau la scène. */
export const ONSCREEN_SETTLE_MS = 600;
/** La durée du fondu d'un changement de scène (`player-onscreen-in` / `-out`, globals.css). */
export const ONSCREEN_FADE_MS = 280;
/** Après le dernier `scroll`, la rangée est encore « en train de défiler » ce temps-là : un appui n'y gonfle rien. */
export const ONSCREEN_SCROLLING_MS = 120;

const signature = (people: readonly XrayPlayerPerson[]) => people.map((p) => p.personId).join(",");

export function PlayerOnScreen({ people, visible, onPick, trailing, maxWidth, onHold, onRelease, onIntent, diag, sceneStart }: PlayerOnScreenProps) {
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
  /** Qui regarde l'a fait défiler depuis le dernier changement de scène : on ne la remet plus au début. */
  const userMoved = useRef(false);
  const touchingNow = useRef(false);
  const hold = useRef(onHold);
  const release = useRef(onRelease);
  useEffect(() => {
    hold.current = onHold;
    release.current = onRelease;
  });
  const touchStart = useCallback(() => {
    if (settleTimer.current !== undefined) window.clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
    userMoved.current = true;
    touchingNow.current = true;
    setTouching(true);
    hold.current?.();
  }, []);
  const touchSettle = useCallback(() => {
    if (pointerDown.current) return;
    if (settleTimer.current !== undefined) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = undefined;
      touchingNow.current = false;
      setTouching(false);
      release.current?.();
    }, ONSCREEN_SETTLE_MS);
  }, []);
  useEffect(() => () => {
    if (settleTimer.current !== undefined) window.clearTimeout(settleTimer.current);
  }, []);

  /** Au début — jamais sous un doigt, ni après qu'on l'a fait défiler dans cette scène. */
  const toStart = useCallback(() => {
    const row = rowRef.current;
    if (!row || userMoved.current || touchingNow.current) return;
    if (row.scrollLeft !== 0) row.scrollLeft = 0;
  }, []);
  // À l'ouverture et à chaque scène : avant que l'image se dessine, puis une image plus tard (l'aimantation
  // de WebKit se rejoue après la mise en page). Une largeur permise qui change fait de même.
  useLayoutEffect(() => {
    userMoved.current = false;
    toStart();
    const frame = window.requestAnimationFrame(toStart);
    return () => window.cancelAnimationFrame(frame);
  }, [shown.sig, toStart]);
  useLayoutEffect(() => {
    toStart();
    const frame = window.requestAnimationFrame(toStart);
    return () => window.cancelAnimationFrame(frame);
  }, [maxWidth, shown.leaving.length, toStart]);

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
    const observer = new ResizeObserver(() => {
      toStart();
      measure();
    });
    observer.observe(row);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure, toStart, shown.sig, maxWidth]);

  /**
   * Le relevé de la rangée (10.29.1) : une ligne par scène montrée, commandes affichées — à l'ouverture et à
   * chaque changement —, une image plus tard (posée et peinte). Ce que l'écran calcule, pas ce que React a écrit :
   * la boîte et l'opacité de la rangée et de sa première pilule. C'est elle qui dira une rangée « revenue vide ».
   */
  const diagRef = useRef({ diag, sceneStart });
  useEffect(() => {
    diagRef.current = { diag, sceneStart };
  });
  const loggedSig = useRef<string | null>(null);
  const mountedOnce = useRef(false);
  useEffect(() => {
    if (!visible || loggedSig.current === shown.sig || !diagRef.current.diag) return;
    const frame = window.requestAnimationFrame(() => {
      const row = rowRef.current;
      const send = diagRef.current.diag;
      if (!send || loggedSig.current === shown.sig) return;
      loggedSig.current = shown.sig;
      const first = row?.querySelector("[data-onscreen-person]") ?? null;
      const rowLook = lookOf(row);
      const firstLook = lookOf(first);
      send("row", {
        trigger: mountedOnce.current ? "scène" : "montée",
        sceneStart: diagRef.current.sceneStart ?? null,
        pills: shown.list.length,
        overflow: row ? row.scrollLeft + row.clientWidth < row.scrollWidth - 2 : null,
        scrollLeft: row ? Math.round(row.scrollLeft) : null,
        row: boxOf(row),
        rowOpacity: rowLook.opacity,
        rowVisibility: rowLook.visibility,
        first: boxOf(first),
        firstOpacity: firstLook.opacity,
        firstVisibility: firstLook.visibility,
      });
      mountedOnce.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shown.sig, shown.list.length, visible]);

  /**
   * La rangée défile encore (le doigt, ou l'élan d'iOS après lui) : marqué sur le nœud, sans rendu — le geste
   * liquide de `PlayerControls` le lit à l'appui et ne gonfle pas une pilule qu'on ne fait qu'arrêter.
   */
  const scrollingTimer = useRef<number | undefined>(undefined);
  const markScrolling = () => {
    const row = rowRef.current;
    if (!row) return;
    row.setAttribute("data-onscreen-scrolling", "");
    window.clearTimeout(scrollingTimer.current);
    scrollingTimer.current = window.setTimeout(() => rowRef.current?.removeAttribute("data-onscreen-scrolling"), ONSCREEN_SCROLLING_MS);
  };
  useEffect(() => () => window.clearTimeout(scrollingTimer.current), []);

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
    touchStart();
    touchSettle();
    const by = Math.max(120, row.clientWidth * 0.8) * direction;
    if (typeof row.scrollBy === "function") row.scrollBy({ left: by, behavior: scrollBehavior() });
    else row.scrollLeft += by;
  };

  // L'intention sur une pilule : le pointeur fin posé là, sans bouger d'elle, `SOFAR_HOVER_INTENT_MS`.
  const intentTimer = useRef<number | undefined>(undefined);
  const intent = useRef(onIntent);
  useEffect(() => {
    intent.current = onIntent;
  });
  useEffect(() => () => window.clearTimeout(intentTimer.current), []);
  const hoverStart = (person: XrayPlayerPerson, e: React.PointerEvent) => {
    window.clearTimeout(intentTimer.current);
    if (e.pointerType !== "mouse" || !intent.current || !finePointer()) return;
    intentTimer.current = window.setTimeout(() => intent.current?.(person), SOFAR_HOVER_INTENT_MS);
  };
  const hoverEnd = () => window.clearTimeout(intentTimer.current);

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
      // Le geste liquide des pilules du lecteur, en version « posée dans ce qu'on fait glisser » (10.29.1).
      data-liquid-pan={leaving ? undefined : "press"}
      onClick={(e) => {
        e.stopPropagation();
        if (leaving) return;
        const row = rowRef.current;
        diag?.("tap", {
          personId: person.personId,
          pills: shown.list.length,
          overflow: edges.after,
          scrollLeft: row ? Math.round(row.scrollLeft) : null,
          pill: boxOf(e.currentTarget),
        });
        onPick(person);
      }}
      onPointerEnter={leaving ? undefined : (e) => hoverStart(person, e)}
      onPointerLeave={hoverEnd}
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
                markScrolling();
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
              className={`player-onscreen-row ${live} flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain`}
            >
              {list.map((person) => pill(person, false))}
              {shown.leaving.map((person) => pill(person, true))}
            </div>
            {/* Le fondu du bord droit : un voile au-dessus des pilules, sous les flèches, jamais un masque sur la
                rangée (10.29.1, voir plus haut). Porté par lui-même (`player-fade`) : il part avec les commandes. */}
            {edges.after && <div aria-hidden data-onscreen-fade="" className="player-fade player-onscreen-fade pointer-events-none absolute inset-y-0 right-0" />}
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

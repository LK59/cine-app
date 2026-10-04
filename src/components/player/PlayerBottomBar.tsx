"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useCinemaRoute, useSheetBehind, useSheetLeaving } from "@/lib/cinemaRoute";
import { useIsShortViewport } from "@/lib/useIsMobile";
import { useHideOnScroll } from "@/lib/useHideOnScroll";
import { useT } from "@/components/TranslationProvider";
import { PLAYER_NAV, activePanel, isOnPanel, openPanel } from "./playerNav";
import { requestSearchFocus } from "@/lib/searchFocus";
import { useReportBadge } from "@/lib/useReportBadge";
import { NavDot } from "./NavDot";
import { LIQUID_SPRING, liquidTransform, prefersReducedMotion, pullFrom } from "@/lib/liquidGlass/liquid";
import { springKeyframes } from "@/lib/liquidGlass/spring";
import type { CinemaRoute } from "@/lib/cinemaRoute";
import type { PlayerPanel } from "./playerNav";

/**
 * La durée du mouvement d'entrée et de sortie.
 *
 * Assez pour qu'on le voie — c'est ce qui distingue une barre qui s'écarte d'une barre qui
 * clignote — et assez court pour qu'on ne l'attende jamais en revenant vers le haut.
 */
const AWAY_MS = 280;

/** Le clic qui suit un appui arrive dans cette fenêtre : au-delà, c'est un vrai clic à lui seul. */
const DOUBLE_FIRE_MS = 700;

/* La lentille (DECISIONS.md §45) : une pastille de verre posée sous l'onglet ouvert, qui glisse
   d'un onglet à l'autre sur le ressort et s'étire selon sa vitesse ; appuyée, elle se soulève et
   suit le doigt, et la barre entière gonfle et s'étire vers lui — plus légèrement que les pilules
   du lecteur (demandé le 04/10/2026). */
const LENS_LIFT = 1.15;
const BAR_SWELL = 1.03;
const BAR_STRENGTH = 0.5;
/** Au-delà de ce déplacement, l'appui devient un glisser : la lentille suit le doigt. */
const DRAG_PX = 6;

const lensAt = (x: number, y: number, swell: number, stretch: number) =>
  `translate(${x}px, ${y}px) scale(${swell * (1 + stretch)}, ${swell * (1 - stretch * 0.45)})`;
const stretchFor = (v: number) => Math.min(Math.abs(v) / 3000, 0.22);

/**
 * La navigation du téléphone.
 *
 * Elle remplace le tiroir et son bouton hamburger. Ce n'était pas une question de nombre
 * d'appuis : les deux coins du haut d'un téléphone sont hors de portée du pouce, et le tiroir
 * demandait de recouvrir tout l'écran pour poser une deuxième question. Il y avait par-dessus le
 * marché deux navigations pour les mêmes quatre destinations — un tiroir ici, un rail sur grand
 * écran. Celle-ci *est* le rail du téléphone.
 *
 * Flottante et non ancrée : une bande pleine largeur collée au bas de l'écran coupe l'affiche en
 * deux, et toute l'identité de cet écran est l'image qui va d'un bord à l'autre. Elle s'efface au
 * défilement vers le bas et revient au moindre retour vers le haut.
 *
 * Couché, elle perd ses mots et ne garde que ses pictogrammes : sur trois cent quatre-vingt-dix
 * pixels de haut, deux lignes de texte en bas de l'écran coûtent une rangée d'affiches.
 */
export function PlayerBottomBar() {
  const t = useT();
  const badge = useReportBadge();
  const route = useCinemaRoute();
  // Effacée pendant qu'une fiche est ouverte : elle recouvre l'écran entier, et la barre y
  // flotterait au-dessus d'un contenu qu'elle ne commande pas.
  const sheetOpen = route.film !== null || route.serie !== null || route.discover !== null || route.person !== null;
  // Mais elle revient *avec* la fiche qui sort, pas après : l'adresse ne lâche le titre qu'à la
  // fin de l'animation de sortie, et attendre ce moment mettait les deux mouvements bout à bout.
  // Sauf s'il reste une fiche dessous — c'est elle qu'on découvre, et elle recouvre l'écran.
  const leaving = useSheetLeaving();
  const sheetBehind = useSheetBehind();
  const covered = sheetOpen && !(leaving && !sheetBehind);
  // Visible pendant la sortie de la fiche, mais pas encore touchable : l'adresse porte toujours
  // le titre, et un onglet choisi à ce moment empilait son entrée *au-dessus* de la fiche — le
  // retour suivant la rouvrait (relevé le 23/09/2026, dû au retour anticipé de la barre).
  const interactive = !sheetOpen;
  const short = useIsShortViewport();
  // Désactivée pendant qu'une fiche recouvre l'écran : sans ça, le défilement de la fiche la
  // laissait « cachée », et refermer la fiche découvrait une barre absente qu'il fallait aller
  // rechercher en remontant. Le crochet repart de zéro quand il reprend la main.
  const hidden = useHideOnScroll(!covered);
  const active = activePanel(route);
  const away = hidden || covered;
  /** Ce qui sépare la barre du bord de l'écran — et donc ce qu'il faut franchir pour en sortir. */
  const gap = `calc(env(safe-area-inset-bottom, 0px) + ${short ? "0.5rem" : "0.75rem"})`;
  /** Quand le pointeur a déjà fait le travail — voir la garde du clic. */
  const handledAt = useRef(0);
  const barRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  /** Où la lentille est posée (repère de la barre), et si un doigt la tient. */
  const lens = useRef({ x: 0, y: 0, placed: false, held: false });
  /**
   * Le second appui sur Recherche, armé au contact et tenu jusqu'au relâchement (04/10/2026).
   *
   * Il levait le clavier dès le contact : partir de Recherche en faisant glisser la lentille vers
   * un autre onglet ouvrait le clavier, qui cassait le geste. Le clavier ne monte plus qu'à un
   * appui relâché sur Recherche, sans glisser — toujours dans le geste, ce qu'iOS exige.
   */
  const searchArmed = useRef<number | null>(null);
  /** Le doigt a fait glisser la lentille pendant cet appui. */
  const lensMoved = useRef(false);
  // La route du moment, pour le relâchement d'un glisser — lue dans un écouteur, pas au rendu.
  const routeRef = useRef<CinemaRoute>(route);
  useEffect(() => {
    routeRef.current = route;
  });

  // La lentille suit l'onglet ouvert : posée d'emblée la première fois, puis glissée sur le
  // ressort. Tenue par un doigt, elle est à lui — le relâchement la posera.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const el = lensRef.current;
    const tab = bar?.querySelector<HTMLElement>(`[data-panel="${active}"]`);
    if (!bar || !el || !tab) return;
    el.style.width = `${tab.offsetWidth}px`;
    el.style.height = `${tab.offsetHeight}px`;
    const l = lens.current;
    const from = l.x;
    l.x = tab.offsetLeft;
    l.y = tab.offsetTop;
    if (l.held) return;
    el.style.transform = lensAt(l.x, l.y, 1, 0);
    if (!l.placed || prefersReducedMotion() || typeof el.animate !== "function" || from === l.x) {
      l.placed = true;
      return;
    }
    const to = l.x;
    const y = l.y;
    const move = springKeyframes(from, to, LIQUID_SPRING, ({ x, v }) => ({ transform: lensAt(x, y, 1, stretchFor(v)) }));
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(move.keyframes, { duration: move.duration, easing: "linear" });
  }, [active, short]);

  // Le doigt sur la barre : la lentille se soulève sous lui et le suit, la barre gonfle et s'étire.
  // La navigation, elle, reste celle d'avant — au contact, par le bouton (`onPointerDown`) ; un
  // glisser qui finit sur un autre onglet l'ouvre au relâchement, à la place du premier.
  useEffect(() => {
    const bar = barRef.current;
    const el = lensRef.current;
    const held = lens.current;
    if (!bar || !el) return;
    const tabs = () => Array.from(bar.querySelectorAll<HTMLElement>("[data-panel]"));
    // `rest` : la barre au repos, mesurée une fois à l'appui — aucune lecture de mise en page par
    // mouvement du doigt.
    let drag: null | { pointerId: number; startX: number; lastX: number; lastT: number; v: number; moved: boolean; w: number; h: number; rest: DOMRect; pull: { r: number; angle: number }; fromPanel: PlayerPanel | null; navigatedOnDown: boolean } = null;

    const lensX = (clientX: number, rest: DOMRect) => {
      const first = tabs()[0];
      const last = tabs().at(-1);
      const x = clientX - rest.left - el.offsetWidth / 2;
      return first && last ? Math.min(Math.max(x, first.offsetLeft - 6), last.offsetLeft + 6) : x;
    };
    const barShape = (r: number, angle: number, swell: number) => liquidTransform(r, angle, swell, drag?.w ?? 0, drag?.h ?? 0, BAR_STRENGTH);

    const onDown = (e: PointerEvent) => {
      if (drag) return;
      lensMoved.current = false;
      if ((e.pointerType === "mouse" && e.button !== 0) || prefersReducedMotion() || typeof el.animate !== "function") return;
      const tab = (e.target as Element | null)?.closest?.<HTMLElement>("[data-panel]") ?? null;
      const panel = (tab?.dataset.panel as PlayerPanel | undefined) ?? null;
      bar.getAnimations().forEach((a) => a.cancel());
      bar.style.transform = "";
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        lastX: e.clientX,
        lastT: e.timeStamp,
        v: 0,
        moved: false,
        w: bar.offsetWidth,
        h: bar.offsetHeight,
        rest: bar.getBoundingClientRect(),
        pull: { r: 0, angle: 0 },
        fromPanel: panel,
        // Lu avant que le bouton ne navigue (cet écouteur passe avant celui de React).
        navigatedOnDown: panel !== null && panel !== activePanel(routeRef.current),
      };
      const l = lens.current;
      l.held = true;
      const x = tab ? tab.offsetLeft : l.x;
      el.getAnimations().forEach((a) => a.cancel());
      el.style.transform = lensAt(x, l.y, LENS_LIFT, 0);
      const lift = springKeyframes(0, 1, LIQUID_SPRING, ({ x: p }) => ({ transform: lensAt(l.x + (x - l.x) * p, l.y, 1 + (LENS_LIFT - 1) * Math.min(p, 1.05), 0) }));
      el.animate(lift.keyframes, { duration: lift.duration, easing: "linear" });
      l.x = x;
      bar.style.transform = barShape(0, 0, BAR_SWELL);
      bar.animate([{ transform: "scale(1)" }, { transform: bar.style.transform }], { duration: 140, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.25)" });
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dt = Math.max(1, e.timeStamp - drag.lastT);
      drag.v = ((e.clientX - drag.lastX) / dt) * 1000;
      drag.lastX = e.clientX;
      drag.lastT = e.timeStamp;
      const box = drag.rest;
      drag.pull = pullFrom(e.clientX - (box.left + box.width / 2), e.clientY - (box.top + box.height / 2), drag.w, drag.h);
      bar.getAnimations().forEach((a) => a.cancel());
      bar.style.transform = barShape(drag.pull.r, drag.pull.angle, BAR_SWELL);
      if (!drag.moved && Math.abs(e.clientX - drag.startX) < DRAG_PX) return;
      drag.moved = true;
      lensMoved.current = true;
      const l = lens.current;
      l.x = lensX(e.clientX, drag.rest);
      el.getAnimations().forEach((a) => a.cancel());
      el.style.transform = lensAt(l.x, l.y, LENS_LIFT, stretchFor(drag.v));
    };
    const settle = (cancelled: boolean) => {
      const d = drag;
      if (!d) return;
      drag = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      // La barre revient sur le ressort.
      const { r, angle } = d.pull;
      bar.style.transform = "";
      const back = springKeyframes(1, 0, LIQUID_SPRING, ({ x }) => ({ transform: liquidTransform(r * Math.max(x, -0.5), angle, 1 + (BAR_SWELL - 1) * x, d.w, d.h, BAR_STRENGTH) }));
      bar.getAnimations().forEach((a) => a.cancel());
      bar.animate(back.keyframes, { duration: back.duration, easing: "linear" });
      // La lentille se pose : sur l'onglet le plus proche après un glisser, sinon sur l'onglet ouvert.
      const l = lens.current;
      const all = tabs();
      let target: HTMLElement | undefined;
      if (d.moved && !cancelled) {
        target = all.reduce<HTMLElement | undefined>((best, t) => (!best || Math.abs(t.offsetLeft - l.x) < Math.abs(best.offsetLeft - l.x) ? t : best), undefined);
      }
      const targetPanel = (target?.dataset.panel as PlayerPanel | undefined) ?? null;
      const current = activePanel(routeRef.current);
      const restTab = all.find((t) => t.dataset.panel === (targetPanel ?? current));
      const from = l.x;
      const to = restTab ? restTab.offsetLeft : l.x;
      l.held = false;
      l.x = to;
      el.style.transform = lensAt(to, l.y, 1, 0);
      const y = l.y;
      const span = Math.max(Math.abs(to - from), 1);
      const land = springKeyframes(from, to, LIQUID_SPRING, ({ x, v }) => ({
        transform: lensAt(x, y, 1 + (LENS_LIFT - 1) * Math.min(1, Math.abs(to - x) / span) * (from === to ? 0 : 1), stretchFor(v)),
      }), d.moved ? d.v : 0);
      el.getAnimations().forEach((a) => a.cancel());
      if (from === to) el.animate([{ transform: lensAt(to, y, LENS_LIFT, 0) }, { transform: lensAt(to, y, 0.96, 0), offset: 0.5 }, { transform: lensAt(to, y, 1, 0) }], { duration: 320, easing: "ease-out" });
      else el.animate(land.keyframes, { duration: land.duration, easing: "linear" });
      if (targetPanel && targetPanel !== current) {
        handledAt.current = Date.now();
        openPanel(targetPanel, routeRef.current, d.navigatedOnDown ? "replace" : "push");
      }
    };
    const onUp = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.pointerId) settle(false);
    };
    const onCancel = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.pointerId) settle(true);
    };
    bar.addEventListener("pointerdown", onDown);
    return () => {
      bar.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      bar.style.transform = "";
      held.held = false;
    };
  }, []);

  return (
    <nav
      aria-label={t("player.nav.label")}
      data-player-nav
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4"
      style={{
        bottom: gap,
        // Transformer, jamais démonter : la barre garde sa place dans l'arbre et ne coûte qu'un
        // déplacement de calque, ce que le compositeur fait sans repeindre quoi que ce soit.
        /**
         * Assez bas pour sortir de l'écran, et pas seulement de sa propre hauteur.
         *
         * La barre flotte à quelques dizaines de pixels du bord — la zone sûre de l'indicateur
         * d'accueil, plus sa marge. Ne la déplacer que de sa hauteur la laissait donc à cheval
         * sur le bord : le mouvement s'arrêtait avec un bandeau encore visible, que `visibility`
         * escamotait ensuite d'un coup. Ce qui se lisait comme une animation en deux temps
         * n'était que ça — un mouvement trop court, suivi d'une coupure.
         */
        transform: away ? `translateY(calc(100% + ${gap} + 1rem))` : "none",
        opacity: covered ? 0 : 1,
        /**
         * `visibility` en dernier, et retardée à la sortie.
         *
         * Elle ne s'interpole pas : appliquée en même temps que la translation, elle escamotait
         * la barre à l'instant zéro et l'animation ne se voyait jamais — la barre semblait
         * disparaître d'un coup. Retardée du temps du mouvement, elle attend qu'il soit fini ;
         * à l'entrée elle repasse à « visible » sans délai, sinon c'est le retour qui manquerait.
         */
        transition: `transform ${AWAY_MS}ms cubic-bezier(0.32, 0.72, 0, 1), opacity 180ms linear, visibility 0s linear ${
          away ? AWAY_MS : 0
        }ms`,
        // Inerte une fois partie, pour qu'elle ne prenne pas un appui destiné à l'image.
        visibility: away ? "hidden" : "visible",
      }}
    >
      <div
        ref={barRef}
        // Le verre liquide, et non plus le fond franc de `player-bar` : essayé sur la page « Tests
        // animations » au-dessus d'une liste qui défile, il est resté fluide sur iPhone — choisi le
        // 04/10/2026. `pan-y` : un défilement vertical commencé sur la barre fait toujours défiler la
        // page ; le glisser horizontal est à la lentille.
        className={`nav-glass relative ${interactive ? "pointer-events-auto" : "pointer-events-none"} flex items-center gap-1 rounded-full ${
          short ? "px-1.5 py-1" : "px-2 py-1.5"
        }`}
        style={{ touchAction: "pan-y" }}
      >
        <span ref={lensRef} className="nav-lens" aria-hidden />
        {PLAYER_NAV.map(({ panel, labelKey, icon: Icon }) => {
          const on = active === panel;
          return (
            <button
              key={panel}
              type="button"
              // `onPointerDown` : sur téléphone, `click` arrive trois cents millisecondes après le
              // doigt. Une navigation qui ne coûte rien doit partir au contact.
              onPointerDown={(e) => {
                if (e.button !== 0 && e.pointerType === "mouse") return;
                handledAt.current = Date.now();
                // Déjà sur Recherche : rien à ouvrir, et le clavier attend le relâchement.
                if (panel === "search" && isOnPanel("search", route)) {
                  searchArmed.current = e.pointerId;
                  return;
                }
                // Le retour visuel est la lentille, qui se soulève sous le doigt (voir plus haut).
                openPanel(panel, route);
              }}
              onPointerUp={(e) => {
                if (searchArmed.current !== e.pointerId) return;
                searchArmed.current = null;
                if (lensMoved.current) return;
                // Relâché sur Recherche ? Au doigt, l'événement vise toujours le bouton du contact :
                // c'est le point de relâchement qui dit où l'on est.
                const under = document.elementFromPoint?.(e.clientX, e.clientY) ?? e.target;
                if ((under as Element | null)?.closest?.('[data-panel="search"]')) requestSearchFocus();
              }}
              onPointerCancel={() => {
                searchArmed.current = null;
              }}
              /* Le bouton ne prend jamais le focus au doigt.
               *
               * Sans ça, le second appui sur « Recherche » levait le clavier puis le refermait
               * aussitôt : le focus partait bien sur le champ au `pointerdown`, et le `mousedown`
               * synthétisé juste après le rendait au bouton. On voyait le clavier monter et
               * redescendre.
               *
               * `mousedown` et non `pointerdown` : c'est celui-là qui déplace le focus, et le
               * prévenir ici laisse intacte la navigation, qui part du pointeur. Le focus au
               * clavier, lui, passe par la tabulation et n'est pas concerné. */
              onMouseDown={(e) => e.preventDefault()}
              /* Le clic reste branché pour le clavier et les technologies d'assistance, qui
                 n'émettent aucun pointeur. Mais un appui en émet un *puis* un clic : sans cette
                 garde, le même geste ouvrirait deux fois, et une entrée d'historique de plus
                 demanderait deux retours pour revenir. */
              onClick={() => {
                if (Date.now() - handledAt.current < DOUBLE_FIRE_MS) return;
                openPanel(panel, route);
              }}
              aria-current={on ? "page" : undefined}
              data-nav-item
              data-panel={panel}
              /* `player-tab` porte la transition des couleurs *et* du geste : la classe utilitaire
                 de Tailwind ne décrivait que la couleur, et les deux écriraient `transition`. */
              className={`player-tab relative flex flex-col items-center justify-center rounded-full ${
                short ? "h-11 w-14 gap-0" : "h-14 w-16 gap-0.5"
              } ${on ? "text-white" : "text-subtle active:text-muted"}`}
            >
              <span className="relative">
                <Icon size={short ? 19 : 20} strokeWidth={on ? 2.4 : 1.8} />
                {panel === "account" && badge.any && <NavDot />}
              </span>
              {/* Sur un écran court, le nom n'est plus affiché mais reste dit : sans lui, le bouton
                  n'avait aucun nom pour un lecteur d'écran (relu le 24/09/2026). */}
              <span className={short ? "sr-only" : `text-[10px] ${on ? "font-semibold" : "font-medium"}`}>{t(labelKey)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

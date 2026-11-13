"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, RotateCw, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { AskPersonBlock } from "@/components/ask/AskPersonHeader";
import { personQuestions } from "@/lib/xray/client";
import type { XrayPlayerPerson } from "@/lib/xray/scenes";
import { NOT_THE_HANDLE, useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
import { phoneSheetFollow, sheetMotionClass } from "@/lib/sheetMotion";
import { useAskTitle, type AskExchange } from "@/lib/ask/client";
import {
  restorePageScroll,
  useAskPanelLayout,
  keyboardSnapshot,
  sendKeyboardDiag,
  KEYBOARD_DIAG_MAX,
  LINE_HEIGHT_PX,
  type AskPanelLayout,
  type ViewportFacts,
} from "@/lib/ask/viewport";
import { ASK_MAX_QUESTION, type AskWhere } from "@/lib/ask/core";
import type { SofarScenes } from "@/lib/ask/sofarCut";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";
import { boxOf, effectiveLookOf, hitAt, lookOf, XRAY_UI_PANEL_CHECK_MS, type XrayUiDiagFn } from "@/lib/xrayUiDiag";

/**
 * Le panneau « Poser une question » (DECISIONS.md §139) — un seul, pour le lecteur (film en pause) et
 * pour toutes les fiches de titre.
 *
 * Un panneau de verre posé à droite, le film ou la fiche visibles à gauche ; une feuille en bas sur un
 * téléphone tenu debout. Les questions proposées d'abord (aucun clavier) ; pendant la frappe, le panneau
 * se réduit à la ligne du champ, posée au-dessus du clavier (`useAskPanelLayout`) ; à l'envoi le champ
 * rend le focus et la réponse arrive dans le panneau entier. Toucher hors du panneau le referme (ou, si
 * l'on écrit, referme seulement le clavier) ; Échap le referme.
 *
 * Ce qu'il tait autour de lui : il porte `data-action-sheet`, la marque qui fait taire les touches des
 * fiches (`sheetKeyBelongsElsewhere`, §117.1) ; ses touches ne remontent pas jusqu'à la fenêtre, où
 * écoute le clavier du lecteur (espace, flèches…) ; ses appuis ne remontent pas jusqu'à la surface du
 * lecteur (qui mettrait en pause) ni au geste de la fiche (qui la tirerait vers le bas).
 *
 * `person` : une personne d'« À l'écran » touchée (§138, 10.27) — le panneau s'ouvre sur elle
 * (`AskPersonBlock` : en-tête, « Jusqu'ici », faits et courte biographie, ses titres dans la bibliothèque),
 * avec des questions faites pour elle (`personQuestions`). `ask={false}` : l'option des questions est
 * coupée pour ce compte — le panneau ne montre que la personne, sans « Jusqu'ici », sans propositions ni
 * champ, et ne demande rien au modèle.
 *
 * La feuille du téléphone debout (10.27) : haute de son contenu (plus d'espace vide), propositions côte à
 * côte, et refermée en la tirant vers le bas par la poignée — le geste des fiches (`useSwipeToDismiss`, qui
 * capture par `usePointerCapture`), la sortie jouée par le geste lui-même (`sheetMotionClass`).
 *
 * Une rotation pendant la frappe (10.27) : le champ rend le focus (le clavier se referme), le texte reste,
 * le panneau se replace dans la nouvelle forme — iOS laissait sinon une ligne posée pour l'ancienne.
 *
 * Il arrive et repart en glissant (09/11/2026 — la fiche n'avait aucun mouvement) : de la droite pour la
 * colonne, du bas pour la feuille du téléphone, par les durées communes (`--animate-fade-in-side`,
 * `--animate-slide-up`, sorties en 0,2 s lues par `ASK_EXIT_MS`) ; toute fermeture passe par
 * `useDelayedClose`. `transform` et `opacity` seulement ; rien sous `prefers-reduced-motion`.
 */
export interface AskPanelProps {
  itemId: string;
  where: AskWhere;
  /** La position du film au moment de la question (lecteur seulement). */
  position?: () => number | null;
  /**
   * La position lue au toucher de la personne (10.28.1, `startSofar`) : « Jusqu'ici » la prend telle quelle — la
   * même que la demande partie au toucher, donc la même coupe et la même clé. Absente : lue à l'ouverture.
   */
  sofarPosition?: number | null;
  onClose: () => void;
  /**
   * Un toucher sur le fond, à ce point de l'écran : vrai s'il a servi à quelque chose de visible dessous (au lecteur,
   * une autre pilule d'« À l'écran » — 13/11/2026), et le panneau reste ouvert ; faux ou absent, il se referme.
   */
  onBackdropTap?: (x: number, y: number) => boolean;
  /** Une personne d'« À l'écran » (§138) : le panneau s'ouvre sur elle. */
  person?: XrayPlayerPerson;
  /** Les personnes de la même scène — pour proposer « son lien avec … ». */
  scene?: readonly XrayPlayerPerson[];
  /**
   * L'option des questions pour cette session — sur une personne, celle des questions sur une personne
   * (`askPersonAvailable`, §139) ; faux : pas de propositions ni de champ.
   */
  ask?: boolean;
  /** « Jusqu'ici » pour cette session (`sofarAvailable`) ; absent, suit `ask` (l'ancien réglage unique). */
  sofar?: boolean;
  /**
   * `player` : dans le conteneur du lecteur (plein écran compris), en absolu ; `sheet` : un portail
   * fixe posé sur la fiche.
   */
  placement: "player" | "sheet";
  /** Les questions proposées à la place des trois d'office. */
  suggestions?: string[];
  /** Les scènes d'« À l'écran » du lecteur : la coupe de « Jusqu'ici » tombe sur un début de scène (10.27.2). */
  scenes?: SofarScenes | null;
  /**
   * Le relevé `xray-ui` du lecteur (10.29.1, `xrayUiDiag.ts`) : le panneau 300 ms après son ouverture — sa boîte,
   * son opacité calculée, ce qui est dessus en son centre — et sa fermeture (par quoi, au bout de combien).
   */
  diag?: XrayUiDiagFn;
}

/** Par quoi le panneau s'est refermé, pour le relevé `xray-ui` ; `démonté` : par son parent (commandes cachées, autre élément). */
type CloseReason = "fond" | "croix" | "glissé" | "échap" | "démonté";

/** La sortie du panneau : la durée de `fade-out-down` et de `ask-panel-out-side` (globals.css). */
export const ASK_EXIT_MS = 200;

const SUGGESTIONS = {
  lecteur: ["ask.chipPlayer0", "ask.chipPlayer1", "ask.chipPlayer2"],
  fiche: ["ask.chipSheet0", "ask.chipSheet1", "ask.chipSheet2"],
} as const;

/** Ce que le panneau dit à la place d'une réponse qui n'est pas venue. */
export function askFailureKey(exchange: Pick<AskExchange, "state" | "error">): string | null {
  if (exchange.state === "rejected") return "ask.unknown";
  if (exchange.state !== "error") return null;
  if (exchange.error === "limite") return "ask.limit";
  if (exchange.error === "indisponible") return "ask.unavailable";
  if (exchange.error === "off") return "ask.off";
  if (exchange.error === "budget") return "ask.budget";
  return "ask.error";
}

/**
 * Le relevé `kind: "clavier"` (voir `keyboardSnapshot`) : écouté au niveau du document (`focusin`), pas par
 * l'état de React — c'est justement ce qu'on veut vérifier —, sur un écran tactile seulement, six lignes par
 * ouverture au plus. Une rafale de `resize` (le clavier qui monte) ne fait qu'une ligne.
 */
function useKeyboardDiag(
  refs: { layer: React.RefObject<HTMLDivElement | null>; panel: React.RefObject<HTMLElement | null>; input: React.RefObject<HTMLInputElement | null> },
  state: { layout: AskPanelLayout; facts: ViewportFacts; where: string; placement: string },
  /** Un champ à écouter (10.29.2 : pas dans le panneau d'une personne). */
  enabled = true,
) {
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  useEffect(() => {
    if (!enabled) return;
    const win = window;
    let coarse = false;
    try {
      coarse = typeof win.matchMedia === "function" && win.matchMedia("(pointer: coarse)").matches;
    } catch {
      coarse = false;
    }
    if (!coarse) return;
    let sent = 0;
    const events = { vvResize: 0, vvScroll: 0, winResize: 0 };
    const timers = new Set<number>();
    let burst: number | undefined;
    const send = (trigger: string) => {
      if (sent >= KEYBOARD_DIAG_MAX) return;
      sent += 1;
      try {
        sendKeyboardDiag(
          keyboardSnapshot(win, { panel: refs.panel.current, input: refs.input.current, layer: refs.layer.current }, { trigger, ...latest.current, events: { ...events } }),
          { build: APP_BUILD, version: APP_VERSION },
        );
      } catch {
        /* un relevé ne casse jamais le panneau */
      }
    };
    const later = (fn: () => void, ms: number) => {
      const id = win.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return id;
    };
    const onFocusIn = (e: FocusEvent) => {
      if (e.target !== refs.input.current) return;
      events.vvResize = events.vvScroll = events.winResize = 0;
      later(() => send("focus"), 50);
      later(() => send("600ms"), 600);
    };
    const focusedNow = () => win.document.activeElement === refs.input.current;
    const onVvResize = () => {
      events.vvResize += 1;
      if (!focusedNow()) return;
      if (burst !== undefined) win.clearTimeout(burst);
      burst = later(() => send("resize"), 150);
    };
    const onVvScroll = () => {
      events.vvScroll += 1;
    };
    const onWinResize = () => {
      events.winResize += 1;
    };
    const vv = win.visualViewport;
    win.document.addEventListener("focusin", onFocusIn);
    vv?.addEventListener("resize", onVvResize);
    vv?.addEventListener("scroll", onVvScroll);
    win.addEventListener("resize", onWinResize);
    return () => {
      for (const id of timers) win.clearTimeout(id);
      win.document.removeEventListener("focusin", onFocusIn);
      vv?.removeEventListener("resize", onVvResize);
      vv?.removeEventListener("scroll", onVvScroll);
      win.removeEventListener("resize", onWinResize);
    };
  }, [refs.input, refs.layer, refs.panel, enabled]);
}

/**
 * Le relevé `xray-ui` du panneau (10.29.1) : une ligne `open` 300 ms après le montage — la boîte du panneau, son
 * opacité et sa visibilité **calculées**, celles de la couche, et ce que `elementFromPoint` trouve en son centre
 * (`panneau` : il est bien dessus ; `fond` : son propre fond est au-dessus de lui ; autre chose : un élément du
 * lecteur) — puis une ligne `close` au démontage : par quoi, au bout de combien. Sur l'iPhone du propriétaire, le
 * panneau de Roy a été monté puis refermé 2,4 s plus tard sans avoir paru : sans doute invisible, et refermé par
 * un toucher sur son fond. Lu une fois, dans un minuteur et au démontage : rien pendant le rendu.
 */
/** Les hauteurs du panneau, pour le relevé `open` — chacune dans sa garde : un relevé ne doit jamais casser l'ouverture. */
function panelSizeFacts(panel: HTMLElement | null, layer: HTMLElement | null): Record<string, unknown> {
  try {
    if (!panel) return {};
    const cs = getComputedStyle(panel);
    const vv = window.visualViewport;
    return {
      sizeStyle: (panel.getAttribute("style") ?? "").slice(0, 120),
      sizeMax: cs.maxHeight,
      sizeH: cs.height,
      sizeKids: [...panel.children].map((c) => Math.round(c.getBoundingClientRect().height)).join(","),
      sizeVv: vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}@${Math.round(vv.offsetTop)}` : null,
      sizeInner: `${window.innerWidth}x${window.innerHeight}`,
      sizeLayer: layer ? Math.round(layer.getBoundingClientRect().height) : null,
    };
  } catch {
    return {};
  }
}

function useXrayPanelDiag(
  diag: XrayUiDiagFn | undefined,
  personId: number | null,
  refs: { panel: React.RefObject<HTMLElement | null>; backdrop: React.RefObject<HTMLElement | null>; layer: React.RefObject<HTMLElement | null> },
  /** Lue au démontage : la raison posée par le dernier geste, pas celle du montage. */
  closeReasonNow: () => CloseReason | null
) {
  const latest = useRef({ diag, personId });
  useEffect(() => {
    latest.current = { diag, personId };
  });
  // Une mise en page, pas un effet : au démontage, son nettoyage passe avant que le panneau quitte le document —
  // un panneau refermé avant les 300 ms est encore mesurable.
  const { panel: panelRef, backdrop: backdropRef, layer: layerRef } = refs;
  useLayoutEffect(() => {
    if (!latest.current.diag) return;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const layer = layerRef.current;
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const openedAt = now();
    let checked = false;
    const check = (early: boolean) => {
      checked = true;
      const box = boxOf(panel);
      const look = lookOf(panel);
      // 10.29.2 : l'opacité cumulée jusqu'à la racine — le cadre du lecteur à 0 cache un panneau à 1.
      const eff = effectiveLookOf(panel);
      latest.current.diag?.("open", {
        personId: latest.current.personId,
        mode: panel?.getAttribute("data-mode") ?? null,
        early: early || undefined,
        openMs: Math.round(now() - openedAt),
        panel: box,
        panelOpacity: look.opacity,
        panelVisibility: look.visibility,
        layerOpacity: lookOf(layer).opacity,
        panelEffOpacity: eff.effOpacity,
        panelHiddenBy: eff.hiddenBy ?? undefined,
        top: hitAt(document, box, panel, backdrop),
        // 13/11/2026 : en paysage sur l'iPhone, le panneau s'ouvrait haut de 0 (10.41.1), et l'émulation WebKit ne le
        // reproduit pas. Ce que la mise en page lui a donné (`style` posé), ce que le navigateur en a fait, la vue
        // visuelle et la hauteur de chaque bloc : de quoi dire lequel tombe à zéro.
        ...panelSizeFacts(panel, layer),
      });
    };
    const timer = window.setTimeout(() => check(false), XRAY_UI_PANEL_CHECK_MS);
    return () => {
      window.clearTimeout(timer);
      if (!checked) check(true);
      latest.current.diag?.("close", { personId: latest.current.personId, reason: closeReasonNow() ?? "démonté", openMs: Math.round(now() - openedAt) });
    };
  }, [panelRef, backdropRef, layerRef, closeReasonNow]);
}

export function AskPanel({ itemId, where, position, sofarPosition, onClose, person, scene, ask: askEnabled = true, sofar: sofarEnabled = askEnabled, placement, suggestions, scenes, diag, onBackdropTap }: AskPanelProps) {
  const t = useT();
  const { exchanges, ask, retry, busy, full } = useAskTitle({
    itemId,
    where,
    position,
    enabled: askEnabled,
    personId: person?.personId,
    about: person ? "person" : "title",
  });
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  // La position pour « Jusqu'ici » : celle du toucher si le lecteur la donne, sinon celle de l'ouverture (une
  // question relit la sienne au moment de partir).
  const [openedAt] = useState(() => (sofarPosition !== undefined ? sofarPosition : position ? position() : null));
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // Le champ libre (10.29.2, décision du propriétaire) : le panneau d'un titre seulement — celui d'une personne du
  // lecteur ne propose que ses liens avec les autres personnages de la scène. Sans champ, ni clavier ni son relevé.
  const freeInput = askEnabled && !person;
  const { layout, facts } = useAskPanelLayout(focused, layerRef, placement);
  useKeyboardDiag({ layer: layerRef, panel: panelRef, input: inputRef }, { layout, facts, where, placement }, freeInput);
  const { closing, requestClose } = useDelayedClose(onClose, ASK_EXIT_MS);
  // La première raison de fermer gagne (une croix pendant le glissé de sortie ne la réécrit pas).
  const closeReason = useRef<CloseReason | null>(null);
  const closeBy = useCallback(
    (reason: CloseReason) => {
      if (!closeReason.current) closeReason.current = reason;
      requestClose();
    },
    [requestClose]
  );
  const closeBySwipe = useCallback(() => closeBy("glissé"), [closeBy]);
  const swipe = useSwipeToDismiss(closeBySwipe, { card: panelRef, follow: phoneSheetFollow });
  const closeReasonNow = useCallback(() => closeReason.current, []);
  useXrayPanelDiag(diag, person?.personId ?? null, { panel: panelRef, backdrop: backdropRef, layer: layerRef }, closeReasonNow);

  // Une rotation pendant la frappe : le clavier se referme (le texte reste), le panneau se replace.
  useEffect(() => {
    const blurIfTyping = () => {
      if (inputRef.current && document.activeElement === inputRef.current) inputRef.current.blur();
    };
    const orientation = typeof screen !== "undefined" ? screen.orientation : undefined;
    orientation?.addEventListener?.("change", blurIfTyping);
    window.addEventListener("orientationchange", blurIfTyping);
    return () => {
      orientation?.removeEventListener?.("change", blurIfTyping);
      window.removeEventListener("orientationchange", blurIfTyping);
    };
  }, []);
  const onCloseRef = useRef(() => closeBy("échap"));
  useEffect(() => {
    onCloseRef.current = () => closeBy("échap");
  }, [closeBy]);

  // Où était la page à l'ouverture : remise après chaque clavier refermé, et au départ du panneau.
  const pageAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    pageAt.current = { x: window.scrollX, y: window.scrollY };
    return () => {
      if (pageAt.current) restorePageScroll(window, pageAt.current);
    };
  }, []);

  // Échap referme — à la capture, avant les écouteurs de la fiche et du lecteur, et arrêtée là.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Rien derrière ne défile au doigt : seul l'espace des réponses défile, et seulement s'il déborde.
  // Un écouteur natif, non passif : React pose les siens passifs, et iOS n'écoute qu'un `preventDefault`
  // fait avant de commencer à faire glisser la page.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    function onTouchMove(e: TouchEvent) {
      const scroller = scrollRef.current;
      if (scroller && e.target instanceof Node && scroller.contains(e.target) && scroller.scrollHeight > scroller.clientHeight) return;
      e.preventDefault();
    }
    layer.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => layer.removeEventListener("touchmove", onTouchMove);
  }, []);

  // Une réponse qui arrive se lit sans chercher : l'espace des réponses descend avec elle — jusqu'à sa
  // dernière ligne, relu une image plus tard (la hauteur du texte n'est connue qu'une fois posé), et quand
  // l'espace change de taille (le clavier refermé, les propositions qui s'en vont).
  // **Seulement quand une question a été posée** (10.27.2) : sans échange, rien ne descend. 10.27.1 descendait
  // aussi à l'ouverture — le panneau d'une personne aux faits déjà gardés s'ouvrait en bas, les premières
  // lignes de la biographie coupées en haut (iPhone couché du propriétaire). Le panneau s'ouvre en haut, et
  // ce qui arrive ensuite (faits, biographie, « Jusqu'ici ») ne le fait pas bouger.
  const last = exchanges[exchanges.length - 1];
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof scroller.scrollTo !== "function" || exchanges.length === 0) return;
    const down = () => scroller.scrollTo({ top: scroller.scrollHeight });
    down();
    const frame = window.requestAnimationFrame(down);
    return () => window.cancelAnimationFrame(frame);
  }, [exchanges.length, last?.answer, last?.state]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined" || typeof scroller.scrollTo !== "function") return;
    const observer = new ResizeObserver(() => {
      if (exchanges.length) scroller.scrollTo({ top: scroller.scrollHeight });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [exchanges.length]);

  function submit(question: string) {
    if (!question.trim() || busy || full) return;
    void ask(question);
    setValue("");
    // Le clavier se referme : la réponse se lit dans le panneau entier, film visible.
    inputRef.current?.blur();
  }

  // La minuterie de `onBlur` est annulée au démontage : un panneau fermé dans les 350 ms ne touche plus à la
  // page (et sous jsdom, elle se déclenchait après la fin du test, `window` déjà parti — portail du 11/11).
  const restoreTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(restoreTimer.current), []);

  function onBlur() {
    setFocused(false);
    // Le clavier a fini de partir avant qu'on remette la page à sa place (iOS la laisse parfois décalée).
    window.clearTimeout(restoreTimer.current);
    restoreTimer.current = window.setTimeout(() => {
      if (pageAt.current) restorePageScroll(window, pageAt.current);
    }, 350);
  }

  const line = layout.mode === "line";
  const sheet = layout.mode === "full" && layout.sheet;
  const asked = new Set(exchanges.map((e) => e.question));
  // Une personne : ses liens avec les autres personnages de la scène, ou rien — jamais les propositions d'office (10.29.2).
  const offered = suggestions?.length ? suggestions : person ? (personQuestions(person, scene ?? [], t) ?? []) : undefined;
  const chips = askEnabled ? (offered ?? SUGGESTIONS[where].map((k) => t(k))).filter((q) => !asked.has(q)) : [];
  // La ligne posée sans mesure du clavier (`inconnu`) se met sous la zone sûre du haut ; en attente de la
  // mesure, invisible — elle ne saute pas du haut vers le bas sous les yeux.
  // La feuille est haute de son contenu (10.27 : un grand vide sous deux lignes) : posée par son bas — le
  // bas de la vue visuelle —, sa hauteur au plus celle que la mise en page lui permet.
  const style: React.CSSProperties = line
    ? {
        top: layout.fromTop ? `calc(${layout.top}px + env(safe-area-inset-top, 0px))` : layout.top,
        height: LINE_HEIGHT_PX,
        opacity: layout.pending ? 0 : undefined,
      }
    : sheet
      ? {
          bottom: `calc(100% - ${layout.top + layout.height}px)`,
          maxHeight: layout.height,
          transform: swipe.touched ? `translateY(${swipe.offset}px)` : undefined,
          transition: swipe.dragging ? "none" : swipe.touched ? "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)" : undefined,
        }
      : // Sur le côté (ordinateur, tablette) aussi : haut de son contenu, au plus la hauteur permise — une fiche
        // d'acteur de quelques lignes occupait tout l'écran, de haut en bas, et ses propositions tombaient sur la
        // barre de lecture (11/11/2026).
        { top: layout.top, maxHeight: layout.height };
  const motion = sheet
    ? sheetMotionClass({ swipe, leaving: closing, revealed: false, out: "animate-fade-out-down", into: "animate-slide-up" })
    : closing
      ? "ask-panel-out-side"
      : "animate-fade-in-side";

  const layer = (
    <div
      ref={layerRef}
      data-ask-layer=""
      data-action-sheet=""
      data-player-surface-ignore=""
      className={`${placement === "player" ? "absolute" : "fixed"} inset-0 select-text overscroll-none`}
      // En style et non en classe arbitraire (la note de `DesktopSheetShell`) : au-dessus des fiches (≤ 49)
      // et sous le lecteur (80) ; dans le lecteur, au-dessus de ses commandes et de ses invites (≤ 30).
      style={{ zIndex: placement === "player" ? 40 : 70 }}
      // Ni pause du lecteur, ni geste de la fiche, ni plein écran au double-clic : rien ne remonte.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Les touches du panneau sont à lui : l'espace écrit ou active une proposition, les flèches
        // bougent le curseur — jamais lecture, pause ni saut.
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      {/* Le film (ou la fiche) visible autour : le toucher referme — ou, pendant la frappe, referme le clavier. */}
      <div
        ref={backdropRef}
        aria-hidden
        data-ask-backdrop=""
        className="absolute inset-0"
        onClick={(e) => {
          if (focused) inputRef.current?.blur();
          // Un toucher sur ce qui se voit à travers le fond et qui sait y répondre (une autre pilule d'« À
          // l'écran », 13/11/2026) : à lui, et le panneau reste ouvert.
          else if (onBackdropTap?.(e.clientX, e.clientY)) return;
          else closeBy("fond");
        }}
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-label={t("ask.title")}
        data-ask-panel=""
        data-mode={line ? "line" : sheet ? "sheet" : "side"}
        data-branch={layout.branch}
        data-closing={closing ? "" : undefined}
        className={`ask-panel absolute flex flex-col overflow-hidden text-white motion-reduce:animate-none ${motion} ${
          line ? "ask-panel-line" : sheet ? "ask-panel-sheet" : "ask-panel-side"
        }`}
        style={style}
      >
        {/* L'en-tête : le titre et la croix — et, sur la feuille du téléphone, la poignée qu'on tire vers le
            bas pour la refermer. Caché pendant la frappe (la ligne seule tient au-dessus du clavier). */}
        <div
          data-ask-handle={sheet ? "" : undefined}
          className={`relative flex shrink-0 items-center justify-between gap-3 px-5 pb-2 ${sheet ? "touch-none pt-5" : "pt-4"}`}
          hidden={line}
          {...(sheet ? swipe.handlers : {})}
        >
          {sheet && <span aria-hidden className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2 rounded-full bg-white/30" />}
          <h2 className="text-[15px] font-semibold">{person ? t("xray.onScreen") : t("ask.title")}</h2>
          <button
            type="button"
            data-ask-close=""
            {...NOT_THE_HANDLE}
            onClick={() => closeBy("croix")}
            aria-label={t("common.close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/20"
          >
            <X size={18} />
          </button>
        </div>
        {/* `ask-scroll` rogne ce qu'il porte (`clip-path`) : sur l'iPhone couché, la fin d'une réponse
            passait sous la proposition restante, dessinée par-dessus (09/11/2026). Propositions et champ
            sont dessous, dans le flux, jamais posés sur le texte. La personne défile avec les échanges : sur
            un téléphone couché, elle ne prend pas la place de la réponse. */}
        <div ref={scrollRef} data-ask-scroll="" className="ask-scroll min-h-0 flex-auto overflow-y-auto overscroll-contain px-5 pb-3" hidden={line}>
          {person && (
            <div data-ask-header="">
              <AskPersonBlock itemId={itemId} person={person} sofar={sofarEnabled} position={openedAt} scenes={scenes} />
            </div>
          )}
          {!askEnabled ? null : exchanges.length === 0 ? (
            person ? null : <p className="pt-1 text-sm leading-6 text-white/70">{t("ask.hint")}</p>
          ) : (
            <ol className="flex flex-col gap-4 pt-1" aria-live="polite">
              {exchanges.map((ex) => {
                const failure = askFailureKey(ex);
                return (
                  <li key={ex.id} data-ask-exchange={ex.state} className="flex flex-col gap-2">
                    <p className="ml-10 self-end rounded-2xl rounded-br-md bg-white/14 px-3 py-1.5 text-[13px] leading-5 text-white/90">{ex.question}</p>
                    {failure === "ask.error" ? (
                      // Une panne : dite proprement, avec de quoi réessayer la même question (10.27).
                      <p data-ask-failed="" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm leading-6 text-white/70">
                        <span>{t(failure)}</span>
                        <button
                          type="button"
                          data-ask-retry=""
                          disabled={busy}
                          onClick={() => retry(ex.id)}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-3 py-1 text-[13px] font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-50"
                        >
                          <RotateCw size={13} aria-hidden />
                          {t("ask.retry")}
                        </button>
                      </p>
                    ) : failure ? (
                      <p className="text-sm leading-6 text-white/70">{t(failure)}</p>
                    ) : ex.state === "waiting" ? (
                      <p className="animate-pulse text-sm leading-6 text-white/60">{t("ask.thinking")}</p>
                    ) : (
                      <p className="text-[15px] leading-6 text-white">{ex.answer}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {askEnabled && full && !busy && <p className="pt-4 text-xs leading-5 text-white/55">{t("ask.maxReached")}</p>}
        </div>
        {!full && chips.length > 0 && (
          <div data-ask-chips="" className="ask-chips flex shrink-0 flex-wrap gap-2 px-5 pb-3" hidden={line}>
            {chips.map((q) => (
              <button
                key={q}
                type="button"
                disabled={busy}
                onClick={() => submit(q)}
                className="max-w-full rounded-full bg-white/12 px-3 py-1.5 text-left text-[13px] leading-5 text-white transition-colors hover:bg-white/20 disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {/* Le champ reste le même nœud dans les deux formes : en changer ferait perdre le focus, et le
            clavier se refermerait aussitôt ouvert. */}
        {freeInput && (
        <form
          className={`flex shrink-0 items-center gap-2 ${line ? "h-full px-2" : "px-4 pb-4"}`}
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
        >
          <input
            ref={inputRef}
            data-ask-input=""
            type="text"
            value={value}
            maxLength={ASK_MAX_QUESTION}
            disabled={full}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={onBlur}
            placeholder={t("ask.placeholder")}
            aria-label={t("ask.placeholder")}
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="on"
            // 16 px au moins : en dessous, Safari agrandit la page au focus — et rien ne la remet.
            className="h-11 min-w-0 flex-1 rounded-full bg-white/12 px-4 text-base text-white placeholder:text-white/50 focus:bg-white/16 focus:outline-none disabled:opacity-50"
          />
          {/* « OK » : refermer le clavier sans envoyer — iOS n'a pas de touche pour cela ici. Le texte reste ;
              le panneau entier revient. Appuyé, il ne prend pas le focus (le champ le perdrait avant le clic). */}
          {focused && (
            <button
              type="button"
              data-ask-done=""
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => inputRef.current?.blur()}
              className="flex h-11 shrink-0 items-center justify-center rounded-full bg-white/12 px-3.5 text-sm font-semibold text-white transition-colors hover:bg-white/20"
            >
              {t("ask.done")}
            </button>
          )}
          <button
            type="submit"
            data-ask-send=""
            aria-label={t("ask.send")}
            disabled={!value.trim() || busy || full}
            // Appuyé, le bouton ne prend pas le focus : le champ le garderait sinon perdu avant l'envoi.
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-black transition-opacity disabled:opacity-40"
          >
            <ArrowUp size={20} strokeWidth={2.4} />
          </button>
        </form>
        )}
      </section>
    </div>
  );

  if (placement === "sheet") return typeof document === "undefined" ? null : createPortal(layer, document.body);
  return layer;
}

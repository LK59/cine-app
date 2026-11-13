"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { afterTwoFrames, swallowStrayClick } from "@/lib/sheetMorph/dom";
import { releaseVelocity } from "@/lib/sheetMorph/motion";
import { usePointerCapture } from "@/lib/usePointerCapture";

// Drag-down-to-close for a full-screen sheet, driven from one grab handle (here: the banner
// artwork at the top of the mobile detail sheet, above its Lire button).
//
// Same Pointer Events approach as ActionSheet's own swipe-to-close and the mini player's drag —
// mouse, touch and pen through one code path, no dependency. What this adds over those is that
// the sheet tracks the finger 1:1 for the whole gesture and can be dragged back up again: the
// offset is state, applied as a transform with the transition switched off while the finger is
// down, so nothing is animating towards a target — the sheet simply is where the finger is.
//
// Release decides: past the distance threshold, or thrown downwards fast enough that the intent
// is obvious even from a short drag, it closes; otherwise it springs back.

// A shade under a quarter of the screen, capped so a tall phone doesn't ask for a longer drag
// than a small one.
const DISTANCE_RATIO = 0.22;
const MAX_DISTANCE = 160;
// px per millisecond — a flick, not a slow drag that happened to be brief.
const VELOCITY_THRESHOLD = 0.5;
/**
 * En dessous, un geste n'est pas un geste : c'est un appui.
 *
 * La vitesse seule ne sait pas les distinguer. Un doigt qui se pose et se lève aussitôt bouge
 * toujours de deux ou trois pixels, et sur quatre millisecondes cela fait 0,75 px/ms — au-delà du
 * seuil, donc une fiche qui se referme parce qu'on l'a touchée. Ça n'arrive que sur un appui vif,
 * ce qui explique que ce soit resté longtemps invisible et que ce soit très déroutant quand ça
 * arrive : « au toucher, ça enlève la fiche ».
 *
 * Vingt-quatre pixels, c'est le seuil habituel au-delà duquel un appui devient un glissement.
 * La distance seule garde son propre seuil, bien plus grand : celui-ci ne fait qu'interdire au
 * raccourci de la vitesse de s'appliquer à quelque chose qui n'a pas bougé.
 */
export const MIN_FLICK_PX = 24;
/**
 * Ce que le premier mouvement peut apporter d'un coup sans que la carte saute : il est retranché du
 * geste, comme le fait une vue défilante d'iOS de sa propre tolérance.
 *
 * Filmé sur l'iPhone (06/11/2026) : le doigt descend, rien ne bouge pendant quatre images, puis la
 * carte saute de ~45 px — WebKit n'envoie le premier `pointermove` qu'une fois sa tolérance passée,
 * et tout ce chemin arrivait en une image. La carte part maintenant du point où le geste est reconnu
 * et suit le doigt pixel pour pixel ensuite. Au-delà de ce plafond, ce n'est plus une tolérance mais
 * des mouvements perdus : la carte rattrape le doigt plutôt que de traîner loin derrière lui. La
 * décision au relâché (distance, vitesse) compte toujours le chemin entier du doigt.
 */
export const FIRST_MOVE_SLOP_MAX_PX = 48;

/**
 * Ce qui suit la carte sous le doigt sans passer par React (option `follow`) : l'ombre d'une fiche
 * soulevée, le voile de la fiche personne. Appelé à chaque mouvement avec le décalage montré, et une
 * fois au retour en place (0).
 */
export type SwipeFollow = (offset: number, card: HTMLElement) => void;

/**
 * Annoncé sur la carte (option `card`) à l'appui sur la poignée, avant tout mouvement : une fiche qui
 * finit encore son ouverture (`useSheetMorph`) la mène à son terme d'un coup, pour que le doigt
 * déplace une seule pièce dès le premier pixel (06/11/2026). Un événement plutôt qu'une option : le
 * geste et l'ouverture sont deux crochets de la même fiche, déclarés dans l'ordre qui lui convient.
 */
export const SHEET_GRAB_EVENT = "cine:sheet-grab";

/**
 * Le décalage du doigt, annoncé sur la carte à chaque mouvement — seulement quand la carte le demande
 * (`SHEET_DRAG_FOLLOW_ATTR`, posé par `useSheetMorph` sur une fiche saisie tôt dans son ouverture, dont
 * la fenêtre du trajet doit suivre le doigt avec elle) ; et une fois au relâché (`released`), avec le
 * décalage final, une fois la transition de la carte rendue par React. Hors de ce cas, rien n'est émis.
 */
export const SHEET_DRAG_EVENT = "cine:sheet-drag";
export const SHEET_DRAG_FOLLOW_ATTR = "data-sheet-drag-follow";
export type SheetDragDetail = { offset: number; released: boolean };

function announceDrag(el: HTMLElement, offset: number, released: boolean): void {
  if (!el.hasAttribute(SHEET_DRAG_FOLLOW_ATTR)) return;
  el.dispatchEvent(new CustomEvent<SheetDragDetail>(SHEET_DRAG_EVENT, { detail: { offset, released } }));
}

/**
 * Le pont du relâché : la durée au-delà de laquelle la carte lancée s'arrêterait si la fermeture
 * tardait encore (elle prend la main deux images plus tard, ~33 ms) — voir `finish`.
 */
const BRIDGE_MS = 400;
/** Au-delà, la vitesse du doigt n'est plus un geste mais un sursaut de mesure (px/s). */
const BRIDGE_MAX_SPEED = 6000;

/** La carte posée à `y` sous le doigt — hors du composant : ses écritures ne sont pas un rendu. */
function placeCard(el: HTMLElement, y: number, follow: SwipeFollow | undefined): void {
  el.style.transform = `translateY(${y}px)`;
  follow?.(y, el);
}

export interface SwipeToDismiss {
  /** Current downward offset in px. 0 when idle. */
  offset: number;
  /** True while a finger is down — the caller kills its transition so the sheet tracks 1:1. */
  dragging: boolean;
  /**
   * True from the first touch of the session onwards, offset back at 0 included. The caller uses
   * it to keep its CSS entrance animation off for good: that animation drives the same transform,
   * so letting it back in after a spring-back replays the whole entrance.
   */
  touched: boolean;
  /**
   * Vrai une fois que c'est le geste lui-même qui a refermé la fiche.
   *
   * C'est la seule chose qui doive faire taire l'animation de sortie : la carte descend déjà par
   * sa transition, dans le prolongement du doigt, et `sheet-out` la ferait remonter d'un coup pour
   * la refaire descendre. Les fiches se servaient de `touched` pour ça, qui ne retombe jamais — si
   * bien qu'après un simple appui sur la bannière, ou un geste revenu en place, chaque fermeture
   * suivante (la croix, Échap, le retour) coupait net au lieu de glisser. Voir `sheetMotionClass`.
   *
   * `touched`, lui, reste tel quel : c'est l'*entrée* qu'il doit garder éteinte pour de bon.
   */
  dismissed: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

/**
 * À poser sur ce qui vit *dans* la poignée sans en faire partie — la croix de la bannière.
 *
 * L'appui y remontait jusqu'à la poignée : le geste démarrait, et la poignée prenait la capture
 * du pointeur — ce qui, sur Chrome pour Android, renvoie le `click` à l'élément qui capture : la
 * croix ne fermait rien. La fiche de bibliothèque arrêtait l'appui à la main ; la fiche découverte
 * l'avait oublié. Un seul objet, pour que la prochaine croix posée sur une bannière n'ait pas à
 * s'en souvenir.
 */
export const NOT_THE_HANDLE = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
} as const;

/**
 * Le temps au bout duquel une fiche jetée au doigt mais toujours nommée par l'adresse revient.
 *
 * Bien au-delà d'une fermeture réelle : le retour arrive au tour suivant, la sortie dure
 * `SHEET_OUT_MS + SHEET_UNMOUNT_SLACK_MS` (400 ms), et la fiche est alors démontée.
 */
export const ADDRESS_GRACE_MS = 1000;

export function useSwipeToDismiss(
  onDismiss: () => void,
  {
    /**
     * La fiche se ferme en changeant l'adresse (`cinemaClose`) — c'est vrai de toutes les fiches du
     * cinéma (DECISIONS.md §74).
     *
     * Le geste jette la carte hors de l'écran et coupe ses pointeurs *avant* que l'adresse ne bouge,
     * et ne la remettait jamais en place : son état disait « fermée » pour toujours. Si la fermeture
     * n'a pas lieu (un retour déjà en vol, que `cinemaClose` refuse de doubler), ou si cette
     * instance resservait plus tard, l'adresse nommait une fiche invisible et sourde — un écran
     * sombre où plus rien ne répond. Ce que dit l'adresse l'emporte : toujours la même une seconde
     * après le geste, la fiche n'a pas été fermée, et elle revient.
     */
    addressed = false,
    /**
     * La carte qui suit le doigt. Donnée, le doigt la déplace **directement** (`style.transform`), sans
     * rendu React par mouvement : `offset` ne change qu'à l'appui et au relâché.
     *
     * Filmé à 60 i/s le 06/11/2026 : sous le doigt, la carte ne bougeait qu'une image sur deux —
     * chaque `pointermove` posait l'état, et toute la fiche (`CinemaMobileDetail` et ses rangées) se
     * redessinait à chaque mouvement. La fiche rend toujours `translateY(offset)` : pendant le geste
     * cette valeur ne change pas, donc React ne touche pas au style écrit ici ; au retour en place,
     * le crochet écrit lui-même le zéro, une fois la transition rendue par React (un `offset` resté à 0
     * ne se réécrirait pas). Sans carte (le banc d'animations, les tests du crochet), l'état suit le
     * doigt comme avant.
     */
    card,
    /** Ce qui suit la carte sans React — voir `SwipeFollow`. */
    follow,
  }: {
    addressed?: boolean;
    card?: RefObject<HTMLElement | null>;
    follow?: SwipeFollow;
  } = {}
): SwipeToDismiss {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [touched, setTouched] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  /** L'adresse au moment où le geste a fermé la fiche — voir `addressed`. */
  const dismissedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!dismissed || !addressed) return;
    const timer = window.setTimeout(() => {
      if (window.location.hash !== dismissedAt.current) return;
      setDismissed(false);
      setOffset(0);
    }, ADDRESS_GRACE_MS);
    return () => clearTimeout(timer);
  }, [dismissed, addressed]);
  const active = useRef(false);
  const startY = useRef(0);
  const startedAt = useRef(0);
  const latest = useRef(0);
  /** La tolérance retranchée au premier mouvement (`FIRST_MOVE_SLOP_MAX_PX`) ; `null` avant lui. */
  const slop = useRef<number | null>(null);
  /** Le retour en place à écrire sur la carte une fois la transition rendue (mode direct). */
  const restPending = useRef<number | null>(null);
  /** Le dernier décalage montré, et les derniers mouvements du doigt (sa vitesse au relâché). */
  const shownRef = useRef(0);
  const moves = useRef<{ t: number; y: number }[]>([]);
  /** La fermeture différée du relâché et le pont qui l'attend — voir `finish`. */
  const bridging = useRef<{ cancel: () => void; anim: Animation } | null>(null);
  // Les options lues par les gestionnaires, tenues à jour sans les recréer.
  const followRef = useRef(follow);
  const cardRef = useRef(card);
  useLayoutEffect(() => {
    followRef.current = follow;
    cardRef.current = card;
  });
  // Prise et rendue par la primitive partagée : trois gestes de cette application capturent le
  // pointeur, et le protocole autour — rendre à la fin, rendre au démontage, ne pas lever sur un
  // pointeur déjà parti — est le seul morceau qu'ils ont en commun. Voir `usePointerCapture`.
  const capture = usePointerCapture();
  // Démontée pendant le pont : rien ne reste en attente, rien ne tient la carte.
  useEffect(
    () => () => {
      bridging.current?.cancel();
      bridging.current?.anim.cancel();
      bridging.current = null;
    },
    []
  );

  // Le retour en place en mode direct : écrit après le rendu qui a rétabli la transition de la carte,
  // pour qu'elle revienne en glissant d'où le doigt l'a laissée.
  useLayoutEffect(() => {
    if (dragging || restPending.current === null) return;
    const final = restPending.current;
    restPending.current = null;
    const el = cardRef.current?.current;
    if (!el) return;
    // Fermée : React a écrit le décalage final (il change) ; seul le retour en place s'écrit ici.
    if (final === 0) placeCard(el, 0, followRef.current);
    announceDrag(el, final, true);
  }, [dragging]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    /**
     * Un appui venu d'un portail n'est pas un appui sur la poignée (13/11/2026).
     *
     * React fait remonter ses événements par l'arbre des composants, pas par celui de la page : une
     * fenêtre rendue dans `document.body` par un composant posé *dans* la poignée — « Partager », dont le
     * bouton vit sur la bannière de la fiche du téléphone — lui envoyait chacun de ses appuis. Depuis que
     * toute la fenêtre se tire au doigt (`ActionSheet`, 13/11/2026), la glisser vers le bas tirait la fiche
     * du film dessous : la poignée prenait la capture du pointeur, la fiche suivait le doigt et se
     * refermait, la fenêtre restait figée — et sur Chrome pour Android, la capture volait le `click` de ses
     * boutons (« Créer le lien » ne répondait pas). Seul ce que la poignée contient dans la page la tire.
     */
    const handle = e.currentTarget as unknown;
    const target = e.target as unknown;
    if (typeof Node !== "undefined" && handle instanceof Node && target instanceof Node && !handle.contains(target)) return;
    // La carte est déjà lancée vers sa fermeture (le pont du relâché) : elle ne se ressaisit plus.
    if (bridging.current) return;
    active.current = true;
    startY.current = e.clientY;
    startedAt.current = performance.now();
    latest.current = 0;
    slop.current = null;
    restPending.current = null;
    shownRef.current = 0;
    moves.current = [{ t: e.timeStamp, y: e.clientY }];
    // La fiche saisie pendant son ouverture finit celle-ci avant de bouger — voir `SHEET_GRAB_EVENT`.
    cardRef.current?.current?.dispatchEvent(new Event(SHEET_GRAB_EVENT));
    setDragging(true);
    setTouched(true);
    // Capture: the finger drags the sheet down out from under itself, so it leaves the handle
    // almost immediately — without this the gesture would die on the first pixel.
    //
    // Sous garde : la prise lève si le pointeur n'est plus actif — un appui déjà relâché quand
    // l'événement arrive, ce qui se produit sous les doigts pressés. Non rattrapée, l'exception
    // part d'un gestionnaire React et emporte l'arbre, pour un geste qui n'aurait rien fait.
    capture.take(e);
  }, [capture]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!active.current) return;
    // Clamped at 0 rather than allowed to go negative: dragging back up returns the sheet
    // exactly to where it started and stops there, which is what "you can change your mind"
    // should feel like. Pulling it up beyond its own top edge would just tear it off the screen.
    const travel = Math.max(0, e.clientY - startY.current);
    // Le premier mouvement : sa tolérance est retranchée, la carte part de là (`FIRST_MOVE_SLOP_MAX_PX`).
    if (slop.current === null) slop.current = Math.min(travel, FIRST_MOVE_SLOP_MAX_PX);
    latest.current = travel;
    const shown = Math.max(0, travel - slop.current);
    shownRef.current = shown;
    moves.current.push({ t: e.timeStamp, y: e.clientY });
    if (moves.current.length > 12) moves.current.shift();
    const el = cardRef.current?.current;
    if (el) {
      // Le mode direct : aucun rendu React par mouvement — voir l'option `card`.
      placeCard(el, shown, followRef.current);
      announceDrag(el, shown, false);
    } else {
      setOffset(shown);
    }
  }, []);

  const finish = useCallback(() => {
    // Rendue avant toute autre chose, et même si le geste n'était pas actif : c'est la seule
    // ligne qui doit s'exécuter quoi qu'il arrive ensuite.
    capture.release();
    if (!active.current) return;
    active.current = false;

    const distance = latest.current;
    const elapsed = Math.max(performance.now() - startedAt.current, 1);
    const threshold = Math.min(MAX_DISTANCE, window.innerHeight * DISTANCE_RATIO);

    if (distance > threshold || (distance >= MIN_FLICK_PX && distance / elapsed > VELOCITY_THRESHOLD)) {
      // Carries on off the bottom instead of snapping back first — the close animation is the
      // continuation of the gesture, not a separate thing that happens after it.
      const dismiss = () => {
        setDragging(false);
        setOffset(window.innerHeight);
        if (cardRef.current?.current) restPending.current = window.innerHeight;
        dismissedAt.current = window.location.hash;
        setDismissed(true);
        onDismiss();
      };
      const el = cardRef.current?.current;
      /**
       * Le pont du relâché (06/11/2026, sixième film) : 13 fermetures au doigt sur 13, la carte restait
       * figée où le doigt l'avait laissée pendant deux à trois images (35 à 50 ms), puis le retour
       * partait. Tout se faisait dans la tâche même du relâché : le rendu de la fiche (geste fini,
       * sortie), la copie de la fiche et sa mise en page (`useSheetMorph`), puis le retour créé en pause
       * et lancé une image plus tard, à son point de départ — l'écran gardait la dernière image tant que
       * cette tâche durait, et la première image du retour était encore la pose de départ.
       *
       * Désormais la carte est lancée sur le compositeur dès le relâché, à la vitesse du doigt
       * (`BRIDGE_MS`, linéaire), avant tout rendu ; la fermeture n'est demandée que deux images plus tard,
       * quand ce pont est déjà parti — il continue de bouger pendant que la tâche lourde s'exécute. La
       * fermeture repart alors de la place que le pont a atteinte, et son horloge part de cet instant
       * (`useSheetMorph`, `continueFrom`) : le compositeur passe d'un mouvement à l'autre sans arrêt.
       * Une fiche saisie tôt, dont le calque du trajet suit le doigt (`SHEET_DRAG_FOLLOW_ATTR`), ferme
       * comme avant : le calque n'a pas de pont.
       */
      if (el && typeof el.animate === "function" && !el.hasAttribute(SHEET_DRAG_FOLLOW_ATTR)) {
        const y0 = shownRef.current;
        const v = Math.min(BRIDGE_MAX_SPEED, Math.max(0, releaseVelocity(moves.current)));
        const anim = el.animate([{ transform: `translateY(${y0}px)` }, { transform: `translateY(${y0 + (v * BRIDGE_MS) / 1000}px)` }], {
          duration: BRIDGE_MS,
          easing: "linear",
          fill: "forwards",
        });
        // Le `click` qui suit le relâché tombait sur ce qu'il y a dessous ; la fermeture l'avalait dans la
        // même tâche, elle arrive maintenant deux images plus tard.
        swallowStrayClick();
        const cancel = afterTwoFrames(() => {
          bridging.current = null;
          // La carte posée où le pont l'a menée, sans transition, puis le pont retiré : la sortie de la
          // fiche (sa transition, la copie de `useSheetMorph`) part de là. La lecture du style fixe ce
          // point de départ pour la transition que le rendu va poser.
          const t = typeof anim.currentTime === "number" ? Math.min(BRIDGE_MS, Math.max(0, anim.currentTime)) : 0;
          el.style.transition = "none";
          placeCard(el, y0 + (v * t) / 1000, followRef.current);
          anim.cancel();
          void getComputedStyle(el).transform;
          flushSync(dismiss);
        });
        bridging.current = { cancel, anim };
        return;
      }
      dismiss();
    } else {
      setDragging(false);
      setOffset(0);
      if (cardRef.current?.current) restPending.current = 0;
    }
  }, [onDismiss, capture]);

  return {
    offset,
    dragging,
    touched,
    dismissed,
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish },
  };
}

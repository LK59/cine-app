"use client";

/**
 * Quand les commandes du lecteur se montrent et se cachent : le minuteur de masquage et ses deux
 * durées, ce qui le suspend (un menu ouvert, une reprise, un doigt sur la barre), la sortie de la
 * fenêtre par la souris. Sorti de `PlayerControls` tel quel, appelé à la place de ses effets.
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { noteViewerPresent } from "@/lib/autoAdvance";
import { keyboardFocusWithin } from "@/lib/playerSkip";
import type { MenuView } from "@/components/playerControls/PlayerSettingsMenu";
import { useLatest } from "@/components/playerControls/useLatest";

export function useAutoHide({
  visible,
  setVisible,
  playing,
  suspended,
  hidden,
  resuming,
  menu,
  setMenu,
  seekingRef,
  liquidRootRef,
}: {
  visible: boolean;
  setVisible: (visible: boolean) => void;
  playing: boolean;
  suspended: boolean;
  hidden: boolean;
  resuming: boolean;
  menu: MenuView | null;
  setMenu: (view: MenuView | null) => void;
  seekingRef: RefObject<boolean>;
  liquidRootRef: RefObject<HTMLDivElement | null>;
}) {
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Shows the controls and (re)starts the auto-hide — called directly from
  // interaction handlers rather than left to a visible-state-diffing effect,
  // since repeated taps while already visible wouldn't otherwise change
  // `visible` and so wouldn't reset the hide timer. Two tiers of delay: a
  // plain tap/hover on the video keeps the default 3s, while interacting with
  // any actual control (top-bar buttons, the audio/subtitle menus, the bottom
  // bar) passes 10s — reading through a track list takes longer than glancing
  // at the seek bar, and the old single 3s timer kept vanishing mid-read
  // (button handlers stopPropagation, so nothing was resetting it at all).
  // Only auto-hides while actually playing; paused stays visible indefinitely.
  // The hide also closes any open menu, so an expired timer can't leave an
  // invisible-but-clickable menu floating over the video.
  // Lu par une référence : le raccourci clavier ne se réabonne pas à chaque lecture/pause, et sa
  // fermeture gardait le `playing` du montage — en pause, puisque les contrôles arrivent avant
  // la lecture. Une touche pendant le film montrait donc les contrôles pour de bon, sans jamais
  // relancer leur disparition (relu le 22/09/2026).
  // Cachées (`hidden`) comptent comme suspendues : le lecteur serveur cache ses commandes sous son
  // écran d'erreur mais garde l'élément monté pour « Réessayer », et l'écouteur clavier, posé sur la
  // fenêtre, survit au `return null`. Espace relançait l'élément en panne sous l'écran — et, retenu
  // au `keydown`, n'activait plus le bouton « Réessayer » qui avait le focus ; les flèches
  // déplaçaient la position d'où il allait reprendre (chasse aux défauts du 13/10/2026).
  const suspendedRef = useLatest(suspended || hidden);
  const playingRef = useLatest(playing);
  /**
   * Un menu ouvert suspend la disparition.
   *
   * Le pointeur qui bougeait dans une liste de pistes relançait le minuteur ordinaire de trois
   * secondes, qui refermait le menu en pleine lecture de la liste ; au clavier, les flèches ne le
   * relançaient pas du tout, et le menu partait au bout de dix secondes (relevé le 23/09/2026).
   * Tant qu'un menu est ouvert, rien ne se cache ; sa fermeture relance le décompte normal.
   */
  const menuOpenRef = useRef(false);
  // Lu par la minuterie de masquage : pendant une reprise, elle attend la première image.
  const resumingRef = useLatest(resuming);
  const showControls = useCallback(
    (delayMs: number = 3000) => {
      // Un geste vaut présence, et c'est ici qu'ils passent tous — un clic, une touche, un
      // pointeur qui bouge. Quelqu'un qui vient de bouger n'a pas à répondre trois épisodes plus
      // tard à une question qui demande s'il est là.
      noteViewerPresent();
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (playingRef.current && !menuOpenRef.current) {
        const hide = () => {
          // Pas pendant une reprise : la minuterie compte depuis la première image, pas depuis
          // l'appui — les commandes ne partent pas pendant que le film n'a pas encore repris.
          if (resumingRef.current) {
            hideTimer.current = setTimeout(hide, delayMs);
            return;
          }
          setVisible(false);
          setMenu(null);
        };
        hideTimer.current = setTimeout(hide, delayMs);
      }
    },
    [setVisible, setMenu, playingRef, resumingRef]
  );

  // Voir `menuOpenRef` : ouvert, le minuteur est suspendu ; refermé, le décompte normal reprend.
  useEffect(() => {
    const wasOpen = menuOpenRef.current;
    menuOpenRef.current = menu !== null;
    if (menu !== null) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    } else if (wasOpen) {
      showControls();
    }
  }, [menu, showControls]);

  function hideControls() {
    setVisible(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }

  // For as long as a pointer is actually on the seek bar (hovering or dragging), controls must
  // never auto-hide at all — not even on a longer timer. Cancels any pending hide with nothing
  // to replace it; the hover/drag handlers below call showControls() again once the pointer
  // actually leaves or is released, restarting the normal countdown from a clean slate.
  function holdControls() {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }

  // Tap toggles explicitly (show <-> hide) again, without reintroducing the
  // Android bug: that bug was touch firing a synthetic mousemove right before
  // click, which forced visible=true a split second before the toggle read
  // it — so every tap net-cancelled itself. Fix is to stop treating touch
  // pointer movement as "show" at all (see onPointerMove below); once that
  // synthetic move no longer touches `visible`, click can safely toggle from
  // whatever the real current state is, for both mouse and touch.
  function toggleControls() {
    if (menu !== null) {
      setMenu(null);
      // The menu just closed from a tap outside it — controls stay up on the
      // normal short timer instead of the previous "no timer at all" (which
      // left them visible forever until another tap).
      showControls();
      return;
    }
    if (visible) hideControls();
    else showControls();
  }

  /**
   * Si une sortie de la fenêtre doit cacher les commandes maintenant. Lue aussi par le `mouseleave`
   * de la barre de progression, qui suit le `pointerout` quand la souris sort par le bas : il les
   * rappelait pour cinq secondes juste après qu'elles étaient parties (chasse aux défauts, 11/10/2026).
   */
  function windowExitHides(): boolean {
    if (!playingRef.current || menuOpenRef.current || seekingRef.current || suspendedRef.current) return false;
    return !keyboardFocusWithin(liquidRootRef.current);
  }
  const windowExitHidesRef = useLatest(windowExitHides);

  /**
   * La souris quitte la fenêtre : les commandes partent aussitôt, sans attendre leurs trois secondes
   * (demandé le 11/10/2026) — personne ne les regarde plus. Seulement pendant la lecture, sans menu
   * ouvert ni glisser sur la barre, et jamais quand le clavier a le focus dans les commandes : on
   * les parcourt alors à la télécommande ou au clavier. Un `pointerout` sans destination
   * (`relatedTarget` nul) est la sortie de la page ; un doigt ne le déclenche jamais (`pointerType`).
   */
  useEffect(() => {
    function onPointerOut(e: PointerEvent) {
      if (e.pointerType !== "mouse" || e.relatedTarget !== null) return;
      if (!windowExitHidesRef.current()) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setVisible(false);
    }
    window.addEventListener("pointerout", onPointerOut);
    return () => window.removeEventListener("pointerout", onPointerOut);
  }, [setVisible, windowExitHidesRef]);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // showControls() does real effect work beyond setState (manages the auto-hide timeout ref),
  // so it can't move to a render-time adjustment. Called unconditionally on every playing
  // change — showControls() itself already only starts the hide timer when playing===true, so
  // this correctly both (a) kicks off the very first auto-hide once playback actually starts
  // (previously gated behind `if (!playing)`, which never re-fires showControls() for the
  // false->true transition — controls stayed visible forever until a manual tap) and
  // (b) forces controls back on with no timer when paused.
  useEffect(() => {
    showControls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  return { suspendedRef, showControls, holdControls, toggleControls, windowExitHides };
}

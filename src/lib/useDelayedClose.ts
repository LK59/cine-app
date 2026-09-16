"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Wraps a close callback so an overlay can play a CSS exit animation before it actually
 * unmounts, instead of vanishing the instant close is requested — React removes a conditionally
 * rendered `{open && <X/>}` from the DOM the very same render `open` goes false, with zero room
 * for a transition to play. This is self-contained on purpose (no change needed on the parent's
 * side, no lifted "is this closing" state): the component keeps calling the SAME `onClose` prop
 * it already had, just via `requestClose()` instead of directly — that's what buys the delay.
 *
 * Usage: replace every place a component used to call its `onClose` prop directly (Escape, a
 * back button, a "play started" auto-close effect) with `requestClose()`, and drive the exit
 * animation class off `closing` (e.g. `closing ? "animate-fade-out" : "animate-fade-in"`). The
 * real `onClose` only fires after `exitMs`, once the animation has had time to actually play.
 */
export function useDelayedClose(onClose: () => void, exitMs: number): { closing: boolean; requestClose: () => void } {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref, not a plain closure over the onClose param — requestClose is called from event handlers
  // that captured whichever onClose was current at THEIR render, but the timeout should still
  // fire the LATEST one if the prop identity ever changes mid-animation. Synced via its own
  // effect (not written during render) per this project's react-hooks/refs rule.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // useCallback so it has a stable identity across renders — callers put it in effect
  // dependency arrays (the auto-close-on-play effect, the Escape/Backspace keydown listener),
  // and a fresh function reference every render would otherwise re-subscribe those on every
  // unrelated re-render (harmless since both are idempotent, but wasteful).
  const requestClose = useCallback(() => {
    if (timerRef.current) return; // already closing — a repeat Escape/click mid-fade is a no-op
    setClosing(true);
    timerRef.current = setTimeout(() => {
      /**
       * Rendu réutilisable avant d'appeler la fermeture, et non après.
       *
       * Le minuteur n'était jamais relâché : une fois parti, `timerRef` restait vrai pour la vie
       * du composant et la garde du dessus — écrite pour absorber un double Échap — refusait
       * *toutes* les fermetures suivantes. Sans conséquence tant qu'une fermeture entraîne le
       * démontage, ce qui est le cas courant. Mais une fiche survit à sa propre fermeture quand
       * un écran est empilé par-dessus pendant l'animation de sortie : la fermeture d'alors part
       * quand même, l'historique recule, et l'instance se retrouve montée, `closing` bloqué à
       * vrai, incapable de se refermer jamais. L'adresse gardait donc `decouverte`, et la barre
       * de navigation du téléphone — qui s'efface pendant qu'une fiche est ouverte — ne revenait
       * plus. C'est la panne « la barre disparaît et ne revient pas » en navigation rapide.
       */
      timerRef.current = null;
      setClosing(false);
      onCloseRef.current();
    }, exitMs);
  }, [exitMs]);

  return { closing, requestClose };
}

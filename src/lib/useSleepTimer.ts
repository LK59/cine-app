"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import {
  blocksAutoAdvance,
  sleepBlocksAdvanceSnapshot,
  sleepFalseServerSnapshot,
  sleepModeSnapshot,
  sleepServerSnapshot,
  sleepTimerDue,
  sleepTimerStore,
  sleepVolumeFactor,
  type SleepMode,
} from "@/lib/sleepTimer";

/** Le battement de la minuterie : assez fin pour une descente du son sans paliers audibles. */
const TICK_MS = 250;

function setVolume(video: HTMLVideoElement, volume: number): void {
  try {
    video.volume = Math.min(1, Math.max(0, volume));
  } catch {
    // Refusé : la descente ne se fera pas, la pause si.
  }
}

/**
 * Le moteur de la minuterie de veille (`sleepTimer.ts`), monté par chacun des deux lecteurs.
 *
 * Dans l'hôte, et non dans les commandes : elles ne sont pas montées dans le mini-lecteur ni
 * pendant une reconstruction, et une minuterie arrêtée parce que le film a été réduit ne serait
 * plus une minuterie. L'état, lui, est au-dessus des deux (le magasin) : ce crochet n'en tient
 * aucun — un épisode enchaîné, une reconstruction, un relais vers le lecteur serveur remontent le
 * crochet, et le décompte reprend où il en était.
 *
 * Le temps est mesuré entre deux battements, pas compté par battement : un onglet en arrière-plan
 * espace ses minuteurs jusqu'à la minute, et le film, lui, continue de jouer.
 *
 * Sur iPhone et iPad, `volume` est en lecture seule : la descente n'y a pas lieu, la pause oui.
 *
 * `onSlept` : la minuterie vient d'arrêter le film — à chaque lecteur d'écrire sa ligne au journal
 * et de rapporter la position à Jellyfin, chacun à sa façon.
 */
export function useSleepTimer(
  videoRef: RefObject<HTMLVideoElement | null>,
  onSlept: (mode: SleepMode) => void
): { blocksAdvance: boolean; holdAtEnd: () => boolean } {
  const onSleptRef = useRef(onSlept);
  useEffect(() => {
    onSleptRef.current = onSlept;
  }, [onSlept]);

  const mode = useSyncExternalStore(sleepTimerStore.subscribe, sleepModeSnapshot, sleepServerSnapshot);
  const blocksAdvance = useSyncExternalStore(sleepTimerStore.subscribe, sleepBlocksAdvanceSnapshot, sleepFalseServerSnapshot);
  const counting = mode !== "off" && mode !== "episode";

  useEffect(() => {
    if (!counting) return;
    let last = performance.now();
    /** L'élément dont le son a été baissé — celui à qui le rendre, même s'il a été remplacé depuis. */
    let faded: HTMLVideoElement | null = null;
    const restore = (video: HTMLVideoElement | null) => {
      const base = sleepTimerStore.fadeBase();
      if (base === null) return;
      if (video) setVolume(video, base);
      sleepTimerStore.setFadeBase(null);
    };
    const id = setInterval(() => {
      const now = performance.now();
      const elapsed = now - last;
      last = now;
      const video = videoRef.current;
      // Ni une pause, ni une attente, ni un film fini ne consomment la minuterie.
      const playing = !!video && !video.paused && !video.ended;
      const state = sleepTimerStore.tick(elapsed, playing);
      if (!video) return;

      const factor = sleepVolumeFactor(state);
      if (factor < 1) {
        // Le volume du spectateur, pris une fois au début de la descente et gardé hors de l'élément.
        let base = sleepTimerStore.fadeBase();
        if (base === null) {
          base = video.volume;
          sleepTimerStore.setFadeBase(base);
        }
        setVolume(video, base * factor);
        faded = video;
      } else {
        // « Continuer » pendant la descente : le son revient tel qu'il était.
        restore(video);
      }

      if (sleepTimerDue(state)) {
        const fired = state.mode;
        video.pause();
        // Rendu à l'élément arrêté : demain, le film reprend au volume d'hier soir, sans un bruit d'ici là.
        restore(video);
        sleepTimerStore.fired();
        onSleptRef.current(fired);
      }
    }, TICK_MS);
    return () => {
      clearInterval(id);
      // La minuterie retirée en pleine descente, ou le lecteur démonté : le son n'a pas à rester bas.
      restore(faded);
    };
  }, [counting, videoRef]);

  /**
   * La fin du fichier : « Fin de l'épisode » la retient-elle ? Appelé par l'écouteur `ended` de
   * chaque lecteur, qui écrit alors la mise en veille au journal comme pour une durée.
   */
  const holdAtEnd = useCallback((): boolean => {
    if (!blocksAutoAdvance(sleepTimerStore.get())) return false;
    onSleptRef.current("episode");
    return true;
  }, []);

  return { blocksAdvance, holdAtEnd };
}

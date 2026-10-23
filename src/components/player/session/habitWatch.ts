// Les habitudes de lecture que les deux lecteurs notent pour la prochaine ouverture (DECISIONS.md
// §28) — écrites une fois le 23/10/2026 (§115) pour le lecteur natif (`startRemux`,
// `ExperimentalPlayerHost.tsx`) et le lecteur serveur (`useServerPositionWatch`) : la lecture notée
// toutes les quinze secondes et à la pause, et le recul de quelques secondes à la reprise après une
// longue pause. Chaque hôte garde ce qui l'entoure dans ses écouteurs (position suivie, sous-titres,
// registre des échecs, téléviseur…).
import { noteWatching, pauseRewindTarget } from "@/lib/resumeRewind";

/**
 * « Ni banc ni scène » : ce que fait cette lecture dit quelque chose d'une reprise. Rien n'est noté
 * pendant un banc d'essai, ni pendant une scène ouverte depuis une réplique (§91) : ce n'est pas une
 * lecture qu'on reprendra. `isScene` n'est demandé qu'hors banc, comme dans chaque copie d'avant.
 */
export function recordsResume(bench: string | boolean | undefined, isScene: () => boolean): boolean {
  return !bench && !isScene();
}

export interface HabitWatchOptions {
  itemId: string;
  bench: string | boolean | undefined;
  isScene: () => boolean;
  /**
   * La pause compte-t-elle ? Le natif : toujours. Le serveur : seulement sur une image
   * (`readyState ≥ HAVE_CURRENT_DATA`) — celle d'un changement de source (élément vidé) n'est pas une
   * pause du spectateur (§28, a3733215).
   */
  pauseCounts: (element: HTMLVideoElement) => boolean;
  /** « Fini » : `lifecycle.isEnded()` pour le natif, `element.ended` pour le serveur. */
  isEnded: (element: HTMLVideoElement) => boolean;
  /** Le recul va être appliqué : le natif l'écrit dans sa trace (le serveur n'en a pas). */
  onRewind?: (target: number, pausedAt: number) => void;
}

/** Un par élément écouté (un pipeline du natif, un `videoKey` du serveur) : il porte `notedAt` et `pausedAt`. */
export function habitWatch(options: HabitWatchOptions): {
  time(element: HTMLVideoElement): void;
  play(element: HTMLVideoElement): void;
  pause(element: HTMLVideoElement): void;
} {
  const { itemId, bench, isScene, pauseCounts, isEnded, onRewind } = options;
  // Retenu toutes les quinze secondes de lecture, et à la pause : ce qui distingue, à la prochaine
  // ouverture, un retour rapide (un relais) d'une vraie reprise (`resumeRewind.ts`). Sans lui, le
  // lecteur serveur aurait reculé à chaque ouverture, même une minute après l'avoir quitté.
  let notedAt = 0;
  let pausedAt: number | null = null;
  return {
    time(element) {
      if (!element.paused && recordsResume(bench, isScene) && Date.now() - notedAt > 15_000) {
        notedAt = Date.now();
        noteWatching(itemId);
      }
    },
    // Après une longue pause, quelques secondes en arrière pour se remettre dans la scène. Pas après
    // la fin — c'est « Revoir », ou un épisode relancé —, ni pendant un saut, ni pendant un banc.
    play(element) {
      const target = !isEnded(element) && !element.seeking && !bench ? pauseRewindTarget(pausedAt, Date.now(), element.currentTime, element.duration) : null;
      if (target !== null && pausedAt !== null) {
        onRewind?.(target, pausedAt);
        element.currentTime = target;
      }
      pausedAt = null;
    },
    pause(element) {
      if (!pauseCounts(element)) return;
      pausedAt = Date.now();
      if (recordsResume(bench, isScene)) noteWatching(itemId);
    },
  };
}

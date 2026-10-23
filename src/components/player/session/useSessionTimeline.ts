// La chronologie des deux dernières minutes (§77) — l'effet que le lecteur natif
// (`useNativeSessionRecord`) et le lecteur serveur (`useServerTimeline`) écrivaient chacun, écrit une
// fois le 23/10/2026 (DECISIONS.md §115). Un échantillon toutes les 5 s, en mémoire, joint par
// `reportPlayback` aux lignes de panne et au bilan (`timeline`).
//
// Appelé à la place exacte de chaque copie : déclarée après l'arrêt écrit au démontage (et, pour le
// natif, après la mesure `diag`), la chronologie est encore là quand la ligne `stop` part.
import { useEffect } from "react";
import { PlaybackTimeline, registerTimeline, type TimelineSample } from "@/lib/playbackTimeline";

/**
 * `key` : ce qui ouvre une nouvelle chronologie. Le natif passe son identifiant de séance (fixe : son
 * hôte est remonté à chaque titre) ; le serveur passe `itemId`, parce qu'il enchaîne l'épisode suivant
 * en place (docs/cycle-de-vie-lecteur.md, « Deux règles de montage ») et qu'une séance du journal
 * s'ouvre alors — `sessionOf` la lit dans l'effet : lue au rendu, ce serait l'ancienne.
 *
 * `sessionOf` et `sample` doivent être stables (des `useCallback` sur des références) : ils sont dans
 * les dépendances pour la règle, l'effet ne se réinstalle qu'au changement de `key`.
 */
export function useSessionTimeline(
  key: unknown,
  sessionOf: () => string,
  sample: () => Omit<TimelineSample, "wall">
): void {
  useEffect(() => {
    const timeline = new PlaybackTimeline(sample).start();
    const unregister = registerTimeline(sessionOf(), timeline);
    return () => {
      timeline.stop();
      unregister();
    };
  }, [key, sessionOf, sample]);
}

/**
 * La position d'un échantillon : `currentTime` s'il est fini et au-delà de zéro, sinon la position que
 * l'hôte suit (`fallback`) — un élément vidé ou pas encore chargé dit 0.
 */
export function timelinePosition(video: HTMLVideoElement | null, fallback: number): number {
  return video && Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime : fallback;
}

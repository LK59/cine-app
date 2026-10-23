import { useCallback, type RefObject } from "react";
import type { LinkMeter } from "@/lib/slowLink";
import { TIMELINE_EVERY_MS, bufferedAhead, elementState } from "@/lib/playbackTimeline";
import { timelinePosition, useSessionTimeline } from "@/components/player/session/useSessionTimeline";

/**
 * La chronologie des deux dernières minutes (§77) : un échantillon toutes les 5 s, en mémoire —
 * débit d'après ce que hls.js reçoit (rien en HLS natif), tampon devant d'après `buffered`. Jointe
 * par `reportPlayback` aux lignes de panne et au bilan. Une par séance : l'épisode suivant en
 * ouvre une autre. Déclarée après l'arrêt au démontage, qui part donc encore avec elle.
 *
 * Les références reçues sont celles de l'hôte, stables : listées dans les dépendances pour la règle,
 * l'effet ne se réinstalle toujours qu'au changement de titre. L'effet est `useSessionTimeline`,
 * commun aux deux lecteurs (§115) ; ici, l'échantillon du serveur : pas de réserve, pas de diagnostic
 * d'attente, et l'identifiant de la séance du journal lu dans l'effet (l'épisode suivant en place).
 */
export function useServerTimeline(
  itemId: string,
  videoRef: RefObject<HTMLVideoElement | null>,
  lastKnownTimeRef: RefObject<number>,
  linkMeterRef: RefObject<LinkMeter | null>,
  logSessionRef: RefObject<{ itemId: string; id: string }>
): void {
  // Suffixés `Ref` ici (l'hôte les nomme `lastKnownTime` et `logSession`) : le compilateur de React ne
  // reconnaît une référence lue dans un `useCallback` qu'à ce nom.
  const sessionOf = useCallback(() => logSessionRef.current.id, [logSessionRef]);
  const sample = useCallback(() => {
    const video = videoRef.current;
    return {
      pos: timelinePosition(video, lastKnownTimeRef.current),
      recvMbps: linkMeterRef.current?.recentMbps(TIMELINE_EVERY_MS) ?? null,
      aheadS: bufferedAhead(video),
      reserveMB: null,
      state: elementState(video),
    };
  }, [videoRef, lastKnownTimeRef, linkMeterRef]);
  useSessionTimeline(itemId, sessionOf, sample);
}

import { useEffect, type RefObject } from "react";
import type { LinkMeter } from "@/lib/slowLink";
import { PlaybackTimeline, TIMELINE_EVERY_MS, bufferedAhead, elementState, registerTimeline } from "@/lib/playbackTimeline";

/**
 * La chronologie des deux dernières minutes (§77) : un échantillon toutes les 5 s, en mémoire —
 * débit d'après ce que hls.js reçoit (rien en HLS natif), tampon devant d'après `buffered`. Jointe
 * par `reportPlayback` aux lignes de panne et au bilan. Une par séance : l'épisode suivant en
 * ouvre une autre. Déclarée après l'arrêt au démontage, qui part donc encore avec elle.
 *
 * Les références reçues sont celles de l'hôte, stables : listées dans les dépendances pour la règle,
 * l'effet ne se réinstalle toujours qu'au changement de titre.
 */
export function useServerTimeline(
  itemId: string,
  videoRef: RefObject<HTMLVideoElement | null>,
  lastKnownTime: RefObject<number>,
  linkMeterRef: RefObject<LinkMeter | null>,
  logSession: RefObject<{ itemId: string; id: string }>
): void {
  useEffect(() => {
    const timeline = new PlaybackTimeline(() => {
      const video = videoRef.current;
      return {
        pos: video && Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime : lastKnownTime.current,
        recvMbps: linkMeterRef.current?.recentMbps(TIMELINE_EVERY_MS) ?? null,
        aheadS: bufferedAhead(video),
        reserveMB: null,
        state: elementState(video),
      };
    }).start();
    const unregister = registerTimeline(logSession.current.id, timeline);
    return () => {
      timeline.stop();
      unregister();
    };
  }, [itemId, videoRef, lastKnownTime, linkMeterRef, logSession]);
}

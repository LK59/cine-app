import { useEffect, type RefObject } from "react";
import type { CastResume } from "@/lib/castResume";
import type { SessionTally } from "@/lib/playerSessionTally";
import { noteWatching, pauseRewindTarget } from "@/lib/resumeRewind";

/**
 * La position suivie sur l'élément du lecteur serveur : la position connue (`lastKnownTime` de
 * l'hôte), le registre des échecs, la reprise sur le téléviseur, la lecture notée pour le recul de
 * la prochaine ouverture, et le recul après une longue pause.
 *
 * Les références reçues sont celles de l'hôte, stables : listées dans les dépendances pour la règle,
 * elles ne réarment rien de plus que `videoKey`, le titre, le banc et `castResume`.
 */
export function useServerPositionWatch(
  videoRef: RefObject<HTMLVideoElement | null>,
  videoKey: number,
  itemId: string,
  bench: string | undefined,
  castResume: CastResume,
  lastKnownTimeRef: RefObject<number>,
  tallyRef: RefObject<SessionTally>,
  isSceneRef: RefObject<() => boolean>
): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Retenu toutes les quinze secondes de lecture, et à la pause : ce qui distingue, à la
    // prochaine ouverture, un retour rapide d'une vraie reprise (`resumeRewind.ts`). Sans lui, ce
    // lecteur aurait reculé à chaque ouverture, même une minute après l'avoir quitté.
    let notedAt = 0;
    const onTimeUpdate = () => {
      // Pas tant que rien n'est chargé : un changement de source remet l'élément à zéro et émet
      // un `timeupdate` à 0 — qui écrasait la position connue, puis celle de Jellyfin au premier
      // battement (relevé le 23/09/2026). La position semée par `startPlayback` tient jusque-là.
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      lastKnownTimeRef.current = video.currentTime;
      // Trois secondes vraiment jouées : la preuve qui efface les échecs du registre (§67).
      tallyRef.current.retries.notePosition(video.currentTime);
      castResume.observed(video.currentTime);
      // Rien de noté pendant une scène (§91) : ce n'est pas une lecture qu'on reprendra.
      if (!video.paused && !bench && !isSceneRef.current() && Date.now() - notedAt > 15_000) {
        notedAt = Date.now();
        noteWatching(itemId);
      }
    };
    // Après une longue pause, quelques secondes en arrière pour se remettre dans la scène — la règle
    // du lecteur natif (`pauseRewindTarget`). Seule une pause sur une image compte : celle d'un
    // changement de source (élément vidé) n'est pas une pause du spectateur.
    let pausedAt: number | null = null;
    const onPause = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      pausedAt = Date.now();
      if (!bench && !isSceneRef.current()) noteWatching(itemId);
    };
    const onPlay = () => {
      const target = !video.ended && !video.seeking && !bench ? pauseRewindTarget(pausedAt, Date.now(), video.currentTime, video.duration) : null;
      pausedAt = null;
      if (target !== null) video.currentTime = target;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
    };
  }, [videoKey, itemId, bench, castResume, videoRef, lastKnownTimeRef, tallyRef, isSceneRef]);
}

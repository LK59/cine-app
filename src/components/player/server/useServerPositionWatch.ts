import { useEffect, type RefObject } from "react";
import type { CastResume } from "@/lib/castResume";
import type { SessionTally } from "@/lib/playerSessionTally";
import { habitWatch } from "@/components/player/session/habitWatch";

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
    // Écrit avec le natif dans `habitWatch` (§28, §115). Rien de noté pendant une scène (§91) : ce
    // n'est pas une lecture qu'on reprendra.
    //
    // Après une longue pause, quelques secondes en arrière pour se remettre dans la scène — la règle
    // du lecteur natif (`pauseRewindTarget`). Seule une pause sur une image compte : celle d'un
    // changement de source (élément vidé) n'est pas une pause du spectateur.
    const habits = habitWatch({
      itemId,
      bench,
      isScene: () => isSceneRef.current(),
      pauseCounts: (element) => element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
      isEnded: (element) => element.ended,
      // Le décompte de la séance en cours, relu à chaque fois : il est remplacé à chaque titre.
      notePosition: (seconds) => tallyRef.current.retries.notePosition(seconds),
    });
    const onTimeUpdate = () => {
      // Pas tant que rien n'est chargé : un changement de source remet l'élément à zéro et émet
      // un `timeupdate` à 0 — qui écrasait la position connue, puis celle de Jellyfin au premier
      // battement (relevé le 23/09/2026). La position semée par `startPlayback` tient jusque-là.
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      lastKnownTimeRef.current = video.currentTime;
      castResume.observed(video.currentTime);
      habits.time(video);
    };
    const onPause = () => habits.pause(video);
    const onPlay = () => habits.play(video);
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

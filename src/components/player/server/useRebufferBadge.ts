import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

// Bad-connection badge: a real stall mid-playback ('waiting' firing after the video has
// already played at least once — excludes ordinary startup buffering) is logged with a
// timestamp; a periodic check then looks at how many landed in the last 60s to decide whether
// to show the badge (the dropped-frame ratio no longer counts since LECTEUR-8, see below). A
// measured signal, not a guess — see badConnection's own comment for why not a fabricated
// "latency" number.
//
// Les références de l'hôte (`hasPlayedOnce`, `lastSeekAt`, `rebufferTimestamps`, remises à zéro par
// `startPlayback`) et le setter sont stables : listés dans les dépendances pour la règle, seul
// `videoKey` réarme l'effet.
export function useRebufferBadge(
  videoRef: RefObject<HTMLVideoElement | null>,
  videoKey: number,
  hasPlayedOnceRef: RefObject<boolean>,
  lastSeekAtRef: RefObject<number>,
  rebufferTimestampsRef: RefObject<number[]>,
  setBadConnection: Dispatch<SetStateAction<boolean>>
): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlaying = () => {
      hasPlayedOnceRef.current = true;
    };
    const onSeeking = () => {
      lastSeekAtRef.current = Date.now();
    };
    const onWaiting = () => {
      if (hasPlayedOnceRef.current && Date.now() - lastSeekAtRef.current > 2000) rebufferTimestampsRef.current.push(Date.now());
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("waiting", onWaiting);

    const interval = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      rebufferTimestampsRef.current = rebufferTimestampsRef.current.filter((t) => t > cutoff);
      // Les attentes seules. Les images perdues (`getVideoPlaybackQuality`) allumaient aussi la
      // pastille, au-delà de 2 % : c'est un décodeur ou un processeur qui ne suit pas — Fire TV,
      // vieux téléphone, machine chargée —, pas le réseau. Passe de nuit du 15/10/2026 (LECTEUR-8) :
      // « Connexion instable » toute une séance servie à 445 Mb/s, segments en 0,1–0,7 s.
      setBadConnection(rebufferTimestampsRef.current.length >= 2);
    }, 5000);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("waiting", onWaiting);
      clearInterval(interval);
    };
  }, [videoKey, videoRef, hasPlayedOnceRef, lastSeekAtRef, rebufferTimestampsRef, setBadConnection]);
}

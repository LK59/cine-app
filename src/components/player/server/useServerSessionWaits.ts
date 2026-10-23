import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type Hls from "hls.js";
import { bufferedAhead } from "@/lib/playbackTimeline";
import type { LinkMeter } from "@/lib/slowLink";
import { PLAYBACK_MEASURE_WINDOW_MS, playbackLinkSlow, type StutterWatch } from "@/lib/slowLinkPolicy";
import type { SlowLinkRunner } from "@/lib/slowLinkRunner";
import type { SessionTally } from "@/lib/playerSessionTally";
import { StallSignals } from "@/components/player/session/stallSignals";

/**
 * Les attentes et les sauts de la séance, pour son bilan — les règles du lecteur natif
 * (`SessionTally`) : une attente compte à partir de 250 ms, en pleine lecture seulement (ni
 * l'ouverture ni un saut) ; un saut compte du geste à la reprise de l'image, ou au `seeked` s'il
 * arrive en pause. Les sauts de l'ouverture (la position de reprise posée par `startPlayback`)
 * précèdent la première lecture et ne comptent pas.
 *
 * Les références et le setter reçus sont ceux de l'hôte, stables : listés dans les dépendances
 * pour la règle, ils ne réarment rien de plus que `videoKey` et `runner`.
 */
export function useServerSessionWaits({
  videoRef,
  videoKey,
  runner,
  hlsRef,
  unstableRef,
  linkMeterRef,
  streamNeedRef,
  stutterRef,
  offerStutterRef,
  playbackDecisionRef,
  setAwaitingTap,
  sessionPlayedRef,
  tallyRef,
  resumeSeekPendingRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoKey: number;
  runner: SlowLinkRunner;
  hlsRef: RefObject<Hls | null>;
  unstableRef: RefObject<boolean>;
  linkMeterRef: RefObject<LinkMeter | null>;
  streamNeedRef: RefObject<number | null>;
  stutterRef: RefObject<StutterWatch>;
  offerStutterRef: RefObject<() => void>;
  playbackDecisionRef: RefObject<(triggered?: boolean, early?: boolean) => void>;
  setAwaitingTap: Dispatch<SetStateAction<boolean>>;
  sessionPlayedRef: RefObject<boolean>;
  tallyRef: RefObject<SessionTally>;
  resumeSeekPendingRef: RefObject<boolean>;
}): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let playedOnce = false;
    let seekSince: number | null = null;
    /**
     * Les saccades (§78), hls.js seulement — c'est lui qui compte ses octets. Une attente est du
     * réseau quand le tampon était vide en son début (moins d'une seconde devant : sinon c'est le
     * décodeur) et que la capacité mesurée sur 30 s est sous le besoin du flux ; jamais pendant une
     * coupure, jamais page cachée. Les attentes d'un saut ne comptent jamais.
     */
    let waitStart: { at: number; ahead: number | null } | null = null;
    // La règle de bascule et son minuteur de 5 s : `StallSignals`, commune aux deux lecteurs (§115).
    const stalls = new StallSignals(() => stutterRef.current, {
      onSwitch: () => offerStutterRef.current(),
      onPrewarm: () => playbackDecisionRef.current(false, true),
    });
    const networkStall = (ahead: number | null) =>
      hlsRef.current !== null &&
      (ahead === null || ahead < 1) &&
      document.visibilityState !== "hidden" &&
      !unstableRef.current &&
      playbackLinkSlow(linkMeterRef.current?.recentMeasure(PLAYBACK_MEASURE_WINDOW_MS), streamNeedRef.current);
    const endWait = (now: number) => {
      const started = waitStart;
      waitStart = null;
      // Le texte du simulateur de la page de test : la durée, et « serveur ».
      stalls.ended(
        now,
        started ? { ms: now - started.at, text: `blocage de ${now - started.at} ms (serveur)`, network: () => networkStall(started.ahead) } : null
      );
    };
    const onPlaying = () => {
      const now = Date.now();
      setAwaitingTap(false);
      playedOnce = true;
      sessionPlayedRef.current = true;
      tallyRef.current.waitEnded(now);
      endWait(now);
      // L'image est là : un saut qui l'attendait n'attend plus (§78).
      runner.seekDone();
      if (seekSince !== null) {
        tallyRef.current.seekArrived(now - seekSince);
        seekSince = null;
      }
    };
    const onWaiting = () => {
      if (playedOnce && !video.seeking && seekSince === null) {
        tallyRef.current.waitStarted(Date.now());
        const ahead = bufferedAhead(video);
        waitStart = { at: Date.now(), ahead };
        stalls.started(() => (waitStart ? networkStall(waitStart.ahead) : null));
      }
    };
    const onSeeking = () => {
      const resumeSeek = resumeSeekPendingRef.current;
      resumeSeekPendingRef.current = false;
      if (!playedOnce) return;
      tallyRef.current.waitAbandoned();
      stalls.cancel();
      waitStart = null;
      // Le saut de reprise de la négociation : ni compté, ni traité comme un saut qui attend (§78).
      if (resumeSeek) return;
      seekSince ??= Date.now();
      // Un saut attend son image : au-delà de 10 s, traité comme une ouverture (§78). Compté depuis le
      // premier d'une série de sauts.
      if (runner.seekPending === null) runner.seekStarted();
    };
    const onSeeked = () => {
      // Posé en pause, ou de quoi repartir aussitôt : ce saut n'attend plus son image (§78).
      if (video.paused || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) runner.seekDone();
      if (seekSince === null || !video.paused) return;
      tallyRef.current.seekArrived(Date.now() - seekSince);
      seekSince = null;
    };
    const onPause = () => {
      tallyRef.current.waitEnded(Date.now());
      endWait(Date.now());
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("pause", onPause);
    return () => {
      stalls.cancel();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("pause", onPause);
    };
  }, [videoKey, runner, videoRef, hlsRef, unstableRef, linkMeterRef, streamNeedRef, stutterRef, offerStutterRef, playbackDecisionRef, setAwaitingTap, sessionPlayedRef, tallyRef, resumeSeekPendingRef]);
}

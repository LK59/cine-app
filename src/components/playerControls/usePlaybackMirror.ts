"use client";

/**
 * Ce que l'élément vidéo dit de lui-même, tenu en état pour les commandes : lecture, attente,
 * position, durée, volume, vitesse, chargé. Sorti de `PlayerControls` tel quel, en deux hooks pour
 * que chaque effet garde sa place parmi ceux du composant : `usePlaybackMirror` (l'état, et le
 * nettoyage de la minuterie de l'intention) là où l'état était déclaré, `useElementMirror` (la
 * synchronisation au montage et les écouteurs) là où étaient ses effets.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { sleepFading } from "@/lib/sleepTimer";
import { VOLUME_STORAGE_KEY } from "@/lib/rememberedVolume";

/** Masqués, les contrôles ne suivent la position qu'à ce rythme — voir `visibleRef`. */
const HIDDEN_UPDATE_MS = 1000;
/** En lecture, le plus long qu'un `progress` attende le tic de la position — voir `readBufferedEnd`. */
const BUFFERED_LATE_MS = 1500;

/** How long a seek may take before it is worth showing as a wait rather than as a still button. */
const SEEK_SPINNER_MS = 150;

export function usePlaybackMirror() {
  const [playing, setPlaying] = useState(false);
  /**
   * Ce que l'appui vient de demander, montré tout de suite (10/10/2026) : le triangle ne devenait
   * pause qu'à l'évènement `play`/`pause` de l'élément, un battement plus tard — davantage sur
   * WebKit, où `play()` attend la sortie audio. Effacé dès que l'élément confirme, ou au bout d'une
   * seconde et demie s'il ne le fait jamais (lecture refusée) : l'icône revient alors à la vérité.
   */
  const [intended, setIntended] = useState<boolean | null>(null);
  const intendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownPlaying = intended ?? playing;
  useEffect(() => {
    const timers = intendTimer;
    return () => {
      if (timers.current) clearTimeout(timers.current);
    };
  }, []);
  const [buffering, setBuffering] = useState(false);
  /** Pending "this seek is taking long enough to say so". */
  const seekSpinner = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  // Stables, pour les dépendances des effets de `useElementMirror`.
  const setters = useMemo(
    () => ({ setPlaying, setIntended, setBuffering, setCurrentTime, setDuration, setVolume, setMuted, setSpeed, setBufferedEnd }),
    []
  );
  return {
    playing,
    shownPlaying,
    intendTimer,
    setIntended,
    buffering,
    seekSpinner,
    currentTime,
    setCurrentTime,
    duration,
    volume,
    muted,
    speed,
    bufferedEnd,
    setters,
  };
}

export function useElementMirror(
  videoRef: RefObject<HTMLVideoElement | null>,
  setters: ReturnType<typeof usePlaybackMirror>["setters"],
  seekSpinner: RefObject<ReturnType<typeof setTimeout> | null>,
  seekingRef: RefObject<boolean>,
  visibleRef: RefObject<boolean>,
  probeVolume: (video: HTMLVideoElement) => void
) {
  const { setPlaying, setIntended, setBuffering, setCurrentTime, setDuration, setVolume, setMuted, setSpeed, setBufferedEnd } = setters;

  // This component remounts every time the player switches between full and mini (only
  // rendered while !isMini in PlayerHost), but the underlying <video> never does — so on
  // remount it can already be mid-playback. Syncing from its actual state here, before paint,
  // avoids a stale "paused" (or 0:00 / 1x volume) flash until the next play/timeupdate/etc.
  // event happens to fire on its own.
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setPlaying(!video.paused);
    setCurrentTime(video.currentTime);
    setDuration(video.duration || 0);
    setVolume(video.volume);
    setMuted(video.muted);
    setSpeed(video.playbackRate || 1);

    probeVolume(video);
  }, [videoRef, probeVolume, setPlaying, setCurrentTime, setDuration, setVolume, setMuted, setSpeed]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => {
      setPlaying(true);
      setIntended(null);
    };
    const onPause = () => {
      setPlaying(false);
      setIntended(null);
      // La position exacte à l'arrêt, que le rythme des contrôles masqués ait laissé passer la
      // dernière ou non — voir `onTime`. Pas pendant qu'on tire la barre : c'est elle qui dit l'instant.
      if (!seekingRef.current) setCurrentTime(video.currentTime);
      // And anything already on its way is called off: the pause may well arrive first.
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      seekSpinner.current = null;
      setBuffering(false);
    };
    // The range containing currentTime (not just the last one) — a rewind past hls.js's
    // in-memory buffer can leave an earlier, already-downloaded range that's no longer the
    // last entry in video.buffered once new data has since loaded ahead of the original spot.
    //
    // Lue au plus une fois par seconde, et en lecture dans le rendu du tic de la position plutôt que
    // dans le sien (`onTime`). Avec une source MediaSource, chaque ajout de données fait tirer
    // `progress` : au banc du 02/10/2026, 4,5 rendus de tout ce composant par seconde commandes
    // affichées au repos, et 2 masquées — pour une jauge qui avance d'un quart de pixel par ajout.
    // Un `progress` que le tic n'a pas repris (une attente : l'horloge ne bouge plus ; une pause :
    // il n'y a plus de tic) est lu par le minuteur, au plus tard `BUFFERED_LATE_MS` après la
    // dernière lecture — la jauge reste ce qui dit, pendant une attente, que ça charge.
    let bufferedAt = -Infinity;
    let bufferedTimer: ReturnType<typeof setTimeout> | null = null;
    const readBufferedEnd = () => {
      if (bufferedTimer) clearTimeout(bufferedTimer);
      bufferedTimer = null;
      bufferedAt = performance.now();
      const ranges = video.buffered;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= video.currentTime && video.currentTime <= ranges.end(i)) {
          setBufferedEnd(ranges.end(i));
          return;
        }
      }
      setBufferedEnd(ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
    };
    // Suppressed while dragging the seek bar — otherwise the real (not-yet-seeked) playback
    // position keeps overwriting the dragged thumb position on every tick, fighting the user's
    // own drag mid-gesture.
    let timeAt = 0;
    let shownSecond = -1;
    const onTime = () => {
      if (seekingRef.current) return;
      const now = performance.now();
      // Jamais la dernière : à l'arrêt ou à la fin, aucune autre ne viendra. La fin de fichier
      // tombait à moins d'une seconde de la précédente, était sautée, et l'écran de fin (« Revoir »,
      // l'épisode suivant — `atEnd`) n'apparaissait pas contrôles masqués (chasse aux défauts du 28/09).
      if (!visibleRef.current && now - timeAt < HIDDEN_UPDATE_MS && !video.paused && !video.ended) return;
      // Affichés aussi, une fois par seconde affichée et pas à chaque `timeupdate` (~4/s) : les deux
      // temps ne changent qu'à la seconde, et la barre avance d'un quart de pixel entre deux — un
      // rendu de tout ce composant pour rien, trois fois sur quatre, pendant qu'on touche aux boutons
      // (revue des performances du 02/10/2026).
      const second = Math.floor(video.currentTime);
      if (visibleRef.current && second === shownSecond && !video.paused && !video.ended) return;
      shownSecond = second;
      timeAt = now;
      setCurrentTime(video.currentTime);
      // La jauge du chargé prend ce même tic, dans le même rendu — voir `readBufferedEnd`.
      readBufferedEnd();
    };
    const onDuration = () => {
      setDuration(video.duration || 0);
      probeVolume(video);
    };
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
      // Gardé d'une séance à l'autre, et rendu à l'élément par les deux lecteurs à son montage
      // (`restoreRememberedVolume`). Seul le lecteur serveur le relisait : dans le lecteur natif,
      // chaque film repartait à plein volume. DECISIONS.md §35.
      // Pas pendant la descente du son de la minuterie de veille : retenu, ce volume presque nul
      // aurait ouvert le film du lendemain en silence.
      if (sleepFading()) return;
      try {
        localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
      } catch {
        // Storage unavailable — just doesn't persist this time.
      }
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => {
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      seekSpinner.current = null;
      setBuffering(false);
    };

    /**
     * A seek is a wait like any other, and it did not look like one.
     *
     * The pause button stayed where it was while the player went and fetched the position, which
     * reads as a freeze rather than as work in progress — and on a dense file that fetch is
     * seconds long. `waiting` is not reliable here: the element can report itself able to play
     * the instant the seek is issued and only stall afterwards.
     *
     * Delayed, because most seeks land in media the player already holds and finish within a
     * frame. A spinner that appears and goes before it can be seen is noise.
     */
    const onSeeking = () => {
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      // Never while paused. Pausing *is* a seek here — the position is re-stated at the button
      // to flush the sound iOS still holds queued (see PlaybackGuard.paused) — so pressing pause
      // announced itself as work: the three centre buttons vanished and the loading thread ran,
      // as though stopping the film needed fetching. A paused player is not working, whatever
      // the element is doing about its own clock.
      if (video.paused) return;
      seekSpinner.current = setTimeout(() => {
        seekSpinner.current = null;
        if (video.seeking && !video.paused) setBuffering(true);
      }, SEEK_SPINNER_MS);
    };
    const onSeeked = () => {
      onPlaying();
      if (!seekingRef.current) setCurrentTime(video.currentTime);
    };
    const onEnded = () => setCurrentTime(video.currentTime);
    const onRateChange = () => setSpeed(video.playbackRate || 1);
    const onProgress = () => {
      if (bufferedTimer) return;
      // En lecture, le tic suivant arrive dans la seconde (`timeupdate` tire toutes les ~250 ms) et
      // emporte la jauge avec lui : le minuteur n'attend donc pas une seconde mais une et demie, pour
      // ne jamais passer avant lui. À l'arrêt, il n'y a pas de tic : une seconde suffit.
      const wait = bufferedAt + (video.paused ? HIDDEN_UPDATE_MS : BUFFERED_LATE_MS) - performance.now();
      if (wait <= 0) readBufferedEnd();
      else bufferedTimer = setTimeout(readBufferedEnd, wait);
    };
    // 'canplay' also clears buffering: when autoplay is blocked (iOS after the reload-based
    // track switch — no user activation on the fresh page), 'playing' never fires without a
    // tap, and a spinner that only 'playing' can dismiss would sit over a ready, paused video
    // forever. canplay is the "enough data to play" signal, which is exactly what buffering
    // is meant to track.
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onDuration);
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("volumechange", onVolume);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("canplay", onPlaying);
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("progress", onProgress);
    video.addEventListener("ended", onEnded);
    onProgress(); // seed immediately — otherwise the bar stays empty until the next chunk lands

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      if (seekSpinner.current) clearTimeout(seekSpinner.current);
      if (bufferedTimer) clearTimeout(bufferedTimer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onPlaying);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onDuration);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("volumechange", onVolume);
      video.removeEventListener("ratechange", onRateChange);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("ended", onEnded);
    };
  }, [
    videoRef,
    probeVolume,
    seekSpinner,
    seekingRef,
    visibleRef,
    setPlaying,
    setIntended,
    setBuffering,
    setCurrentTime,
    setDuration,
    setVolume,
    setMuted,
    setSpeed,
    setBufferedEnd,
  ]);
}

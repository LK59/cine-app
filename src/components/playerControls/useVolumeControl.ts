"use client";

/**
 * Le volume tel que les commandes le règlent : la plateforme laisse-t-elle une page le régler
 * (`volumeSettable`, sondé une fois par élément), le curseur et le bouton muet. Sorti de
 * `PlayerControls` tel quel, appelé à la place où son état était déclaré ; `probeVolume` est
 * passé à `useElementMirror`, qui le rappelle au montage et à chaque `durationchange`. Ce que
 * l'élément dit de son volume, et sa mémoire d'une séance à l'autre, restent dans ses écouteurs
 * (`usePlaybackMirror.ts`).
 */

import { useCallback, useRef, useState, type RefObject } from "react";

export function useVolumeControl(videoRef: RefObject<HTMLVideoElement | null>) {
  /** The element whose volume has already been probed, so it is probed once and not per render. */
  const probedVolumeOn = useRef<HTMLVideoElement | null>(null);

  /**
   * Whether this platform lets a page set the volume at all.
   *
   * iOS does not: `volume` on a media element is read-only there, silently, and the hardware
   * buttons are the only control. So the slider did nothing except through the one line that
   * *did* work — muting at zero — which is exactly what it looked like from the outside: a bar
   * that turned the sound off and on and had no middle.
   */
  const [volumeSettable, setVolumeSettable] = useState(true);

  /**
   * Whether this platform will let a page set the volume of a media element.
   *
   * Asked of the platform's name, which is not how anything else here is decided — and the
   * exception is earned. Trying it and reading it back, which is what this did, cannot work:
   * iOS *stores* the value written to `video.volume` and hands it back unchanged, while the
   * output ignores it entirely. The probe therefore answered "yes" every time, the control
   * stayed on screen, and it behaved as a mute switch with nothing in between — which is what
   * was reported, twice. A measurement whose subject lies is not a measurement.
   *
   * Narrow on purpose: only Apple's mobile systems, where the write is ignored — the control stays
   * where it works and goes where it does not.
   */
  const probeVolume = useCallback((video: HTMLVideoElement) => {
    if (probedVolumeOn.current === video) return;
    probedVolumeOn.current = video;

    const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const iPadPretendingToBeAMac =
      typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    const readOnlyThere = /iPad|iPhone|iPod/.test(agent) || iPadPretendingToBeAMac;
    if (readOnlyThere && video instanceof HTMLMediaElement) {
      setVolumeSettable(false);
      return;
    }

    // Everywhere else the question can still be answered by asking, and is: a platform nobody
    // thought of that ignores the write takes the control off the screen too.
    const before = video.volume;
    try {
      video.volume = before > 0.5 ? before - 0.1 : before + 0.1;
      const took = video.volume !== before;
      video.volume = before;
      setVolumeSettable(took);
    } catch {
      setVolumeSettable(false);
    }
  }, []);

  function toggleMute() {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }

  function changeVolume(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    // The last word belongs to what actually happened. If the platform ignored the write, the
    // control has just proved itself useless and takes itself off the screen — rather than
    // staying there as a bar with nothing between its two ends.
    if (value > 0 && value < 1 && video.volume !== value) setVolumeSettable(false);
  }

  return { volumeSettable, probeVolume, toggleMute, changeVolume };
}

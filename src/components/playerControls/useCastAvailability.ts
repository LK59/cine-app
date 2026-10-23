"use client";

/**
 * Le bouton de diffusion du navigateur (AirPlay ou Remote Playback) : existe-t-il ici, et lequel.
 * Sorti de `PlayerControls` tel quel — sa détection vivait dans l'effet des écouteurs de l'élément.
 */

import { useEffect, useState, type RefObject } from "react";

// AirPlay (Safari, webkit-prefixed) isn't in lib.dom's HTMLVideoElement typings — unlike the
// standard Remote Playback API (Chrome/Edge's actual Chromecast entry point for a plain
// <video>), which `video.remote` already covers natively.
export interface CastVideoElement extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
}

export function useCastAvailability(videoRef: RefObject<HTMLVideoElement | null>) {
  const [castSupported, setCastSupported] = useState(false);
  /** AirPlay (WebKit) ou Remote Playback : ne change que le mot de la confirmation. */
  const [castKind, setCastKind] = useState<"airplay" | "remote">("remote");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Cast — AirPlay (Safari, webkit-prefixed) where available, else the standard Remote
    // Playback API (Chrome/Edge's real Chromecast entry point for a <video>). Never both: a
    // browser that has AirPlay is Safari, which doesn't meaningfully implement Remote Playback,
    // so checking AirPlay first and only falling back avoids ever probing the one that doesn't
    // apply.
    const castVideo = video as CastVideoElement;
    let remoteWatchId: number | undefined;
    // La promesse d'abonnement peut se résoudre après le démontage : l'identifiant arrivait alors
    // trop tard pour être annulé, et l'abonnement survivait au lecteur (23/09/2026).
    let unmounted = false;
    if (typeof castVideo.webkitShowPlaybackTargetPicker === "function") {
      setCastSupported(true);
      setCastKind("airplay");
    } else if (castVideo.remote) {
      const remote = castVideo.remote;
      remote
        .watchAvailability((available) => {
          if (!unmounted) setCastSupported(available);
        })
        .then((id) => {
          if (unmounted) remote.cancelWatchAvailability(id).catch(() => {});
          else remoteWatchId = id;
        })
        .catch(() => {
          if (!unmounted) setCastSupported(false); // NotSupportedError — no cast receivers reachable at all
        });
    }

    return () => {
      unmounted = true;
      if (remoteWatchId !== undefined) castVideo.remote?.cancelWatchAvailability(remoteWatchId).catch(() => {});
    };
  }, [videoRef]);

  return { castSupported, castKind };
}

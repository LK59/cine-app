"use client";

import { useEffect } from "react";

/**
 * Tells the system what is playing, and takes its buttons.
 *
 * Nothing here was set, and a media element playing sound claims the system's Now Playing slot
 * whether or not anybody describes what is in it. So iOS showed a live activity for this film
 * carrying whatever the last web app to set one had left behind — which is why tapping it opened
 * a different application entirely. Claiming the session is what puts our own name on it.
 *
 * The rest is what a lock screen, a Dynamic Island, a car stereo and a pair of headphones all
 * expect from something that plays: a title, a picture, working buttons, and a position that
 * moves. All of it already exists in the player; none of it was being offered.
 */
export interface MediaSessionInfo {
  /** "Série — S02E05 · Titre" as the player shows it, split for the two lines a system offers. */
  title: string;
  artworkUrl: string | null;
  duration: number;
  position: number;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (seconds: number) => void;
  onSkip: (delta: number) => void;
  onNext: (() => void) | null;
}

/** The series and the episode, from the one string the player was given. */
function split(title: string): { track: string; album: string } {
  const cut = title.indexOf(" — ");
  return cut === -1 ? { track: title, album: "" } : { track: title.slice(cut + 3), album: title.slice(0, cut) };
}

export function useMediaSession(info: MediaSessionInfo | null): void {
  const { title, artworkUrl, playing, onPlay, onPause, onSeek, onSkip, onNext } = info ?? {};

  // Metadata, and the handlers that go with it. Deliberately separate from the position below,
  // which changes four times a second and must not re-register anything.
  useEffect(() => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
    if (!media || !info || !title) return;

    const { track, album } = split(title);
    try {
      media.metadata = new MediaMetadata({
        title: track,
        artist: album || "Cine App",
        album,
        artwork: artworkUrl ? [{ src: artworkUrl, sizes: "512x512", type: "image/jpeg" }] : [],
      });
    } catch {
      // A platform without MediaMetadata still gets the handlers below, which are what the
      // headphone buttons actually reach.
    }

    // Registered as a list so every one of them is removed again on the way out: a handler left
    // behind belongs to a film that is no longer playing, and the buttons would still reach it.
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => onPlay?.()],
      ["pause", () => onPause?.()],
      ["seekbackward", (details) => onSkip?.(-(details.seekOffset ?? 10))],
      ["seekforward", (details) => onSkip?.(details.seekOffset ?? 10)],
      ["seekto", (details) => details.seekTime != null && onSeek?.(details.seekTime)],
      ...(onNext ? ([["nexttrack", () => onNext()]] as [MediaSessionAction, MediaSessionActionHandler][]) : []),
    ];
    for (const [action, handler] of handlers) {
      try {
        media.setActionHandler(action, handler);
      } catch {
        // An action this platform does not know about. The others still register.
      }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          media.setActionHandler(action, null);
        } catch {
          // Already gone with the session.
        }
      }
      media.metadata = null;
    };
  }, [info, title, artworkUrl, onPlay, onPause, onSeek, onSkip, onNext]);

  // What the scrubber on a lock screen reads. Updated on its own so the metadata above is not
  // rebuilt four times a second.
  useEffect(() => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
    if (!media || !info) return;
    media.playbackState = playing ? "playing" : "paused";
    if (!media.setPositionState || !(info.duration > 0)) return;
    try {
      media.setPositionState({
        duration: info.duration,
        position: Math.min(info.position, info.duration),
        playbackRate: 1,
      });
    } catch {
      // A position the platform will not take — out of range while a seek is in flight, say.
      // The next update is a quarter of a second away.
    }
  }, [info, playing]);
}

// Minimal ambient types for just the surface CinemaTrailerBackdrop actually uses — not the full
// @types/youtube package (a sizeable dependency for four methods and one event).
export interface YTPlayer {
  mute(): void;
  unMute(): void;
  destroy(): void;
  getIframe(): HTMLIFrameElement;
  /** Seconds elapsed in the current playback — polled to time the backdrop's reveal past
   *  YouTube's own startup overlay (see CinemaTrailerBackdrop). */
  getCurrentTime(): number;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
}

interface YTPlayerVars {
  autoplay?: 0 | 1;
  mute?: 0 | 1;
  controls?: 0 | 1;
  loop?: 0 | 1;
  playlist?: string;
  modestbranding?: 0 | 1;
  rel?: 0 | 1;
  playsinline?: 0 | 1;
  disablekb?: 0 | 1;
  fs?: 0 | 1;
  iv_load_policy?: 1 | 3;
}

export interface YTOnStateChangeEvent {
  data: number;
  target: YTPlayer;
}

export interface YTOnReadyEvent {
  target: YTPlayer;
}

export interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      width?: number;
      height?: number;
      playerVars?: YTPlayerVars;
      events?: {
        onReady?: (e: YTOnReadyEvent) => void;
        onStateChange?: (e: YTOnStateChangeEvent) => void;
      };
    }
  ) => YTPlayer;
  PlayerState: { PLAYING: number; ENDED: number; PAUSED: number; BUFFERING: number; CUED: number; UNSTARTED: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

// The real IFrame Player API, not raw postMessage guessing — gives an actual "onStateChange ->
// PLAYING" event to key the reveal off of, rather than a fixed timer hoping YouTube's own
// startup title/control overlay has faded by then (see CinemaTrailerBackdrop's own doc comment
// on why a blind timer wasn't reliable). Loaded once and cached — every call after the first
// (across every focus change) reuses the same script tag and resolved promise.
export function loadYoutubeIframeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    if (!document.getElementById("youtube-iframe-api")) {
      const script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });
  return apiPromise;
}

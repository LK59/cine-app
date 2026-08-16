"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, X, Captions, AudioLines, Cast, Loader2, ChevronDown, Info, RotateCcw, RotateCw, PictureInPicture2, Gauge, ListVideo } from "lucide-react";

export interface Track {
  id: number;
  label: string;
}

interface PlayerControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  itemId: string;
  title: string;
  onClose: () => void;
  onMinimize: () => void;
  onTogglePlaybackInfo: () => void;
  audioTracks: Track[];
  currentAudioId: number | null;
  onChangeAudio: (id: number) => void;
  subtitleTracks: Track[];
  currentSubtitleId: number | null;
  onChangeSubtitle: (id: number | null) => void;
  hidden: boolean;
  loading: boolean;
  introSkip: { start: number; end: number } | null;
  creditsStart: number | null;
  nextEpisode: { itemId: string; title: string } | null;
  onAdvance: () => void;
}

const NEXT_UP_COUNTDOWN_S = 10;
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const VOLUME_STORAGE_KEY = "cine:player-volume";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function PlayerControls({
  videoRef,
  containerRef,
  itemId,
  title,
  onClose,
  onMinimize,
  onTogglePlaybackInfo,
  audioTracks,
  currentAudioId,
  onChangeAudio,
  subtitleTracks,
  currentSubtitleId,
  onChangeSubtitle,
  hidden,
  loading,
  introSkip,
  creditsStart,
  nextEpisode,
  onAdvance,
}: PlayerControlsProps) {
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(true);
  const [menu, setMenu] = useState<null | "audio" | "subtitles" | "speed" | "chapters">(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [airPlaySupported, setAirPlaySupported] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  // Independent of `menu`/`mode` (full vs. our own mini) — the browser's native
  // Picture-in-Picture is an OS-level window, not something our React state controls; this only
  // mirrors the browser's own 'enter'/'leavepictureinpicture' events for the button's icon/state.
  const [pipActive, setPipActive] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [chapters, setChapters] = useState<{ start: number; name: string }[]>([]);
  const [nextUpDismissed, setNextUpDismissed] = useState(false);
  const [nextUpCountdown, setNextUpCountdown] = useState(NEXT_UP_COUNTDOWN_S);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a pointer/touch is actively down on the seek bar. Read (not state — nothing
  // needs to re-render off it directly) by the 'timeupdate' handler to stop the real playback
  // position from fighting the dragged one, and by the two hide-suppression handlers below.
  const seekingRef = useRef(false);

  // Reset the dismiss/countdown state whenever a genuinely new "next episode" context arrives
  // (i.e. we've actually advanced), not on every render. Applied during render (not in an
  // effect) per React's guidance for adjusting state from a prop change.
  const nextUpKey = `${creditsStart ?? ""}:${nextEpisode?.itemId ?? ""}`;
  const [resetForNextUpKey, setResetForNextUpKey] = useState(nextUpKey);
  if (nextUpKey !== resetForNextUpKey) {
    setResetForNextUpKey(nextUpKey);
    setNextUpDismissed(false);
    setNextUpCountdown(NEXT_UP_COUNTDOWN_S);
  }

  const showNextUp = creditsStart != null && currentTime >= creditsStart && !!nextEpisode && !nextUpDismissed;

  useEffect(() => {
    if (!showNextUp) return;
    const id = setInterval(() => setNextUpCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [showNextUp]);

  useEffect(() => {
    if (showNextUp && nextUpCountdown === 0) onAdvance();
  }, [showNextUp, nextUpCountdown, onAdvance]);

  const showSkipIntro = !!introSkip && currentTime >= introSkip.start && currentTime < introSkip.end;

  // `document` is unavailable during SSR — feature detection must run post-mount. State starts
  // at the fixed `false`, matching SSR output, so this doesn't cause a hydration mismatch.
  useEffect(() => {
    // iPhone Safari doesn't support the standard Fullscreen API on arbitrary
    // elements (only iPad/desktop do) — feature-detect rather than show a
    // button that silently does nothing there. The player already fills the
    // whole viewport as a fixed overlay, and in an installed PWA (no browser
    // chrome to hide) that's effectively fullscreen already.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFullscreenSupported(typeof document !== "undefined" && document.fullscreenEnabled);
  }, []);

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
    setPipActive(document.pictureInPictureElement === video);
  }, [videoRef]);

  // Chapters — fetched once per item, same shape/lifecycle as the trickplay metadata below.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jellyfin/chapters?itemId=${itemId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setChapters(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setChapters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    // Suppressed while dragging the seek bar — otherwise the real (not-yet-seeked) playback
    // position keeps overwriting the dragged thumb position on every tick, fighting the user's
    // own drag mid-gesture.
    const onTime = () => {
      if (!seekingRef.current) setCurrentTime(video.currentTime);
    };
    const onDuration = () => setDuration(video.duration || 0);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
      // Remembered across sessions — applied back on a fresh session in PlayerHost's mount
      // effect, so the user doesn't have to turn the volume back up every single time.
      try {
        localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
      } catch {
        // Storage unavailable — just doesn't persist this time.
      }
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    const onRateChange = () => setSpeed(video.playbackRate || 1);
    const onEnterPip = () => setPipActive(true);
    const onLeavePip = () => setPipActive(false);
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
    video.addEventListener("canplay", onPlaying);
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("enterpictureinpicture", onEnterPip);
    video.addEventListener("leavepictureinpicture", onLeavePip);
    // Safari-only API — feature-detected, not part of the standard HTMLVideoElement type.
    setAirPlaySupported(
      typeof (video as unknown as { webkitShowPlaybackTargetPicker?: unknown })
        .webkitShowPlaybackTargetPicker === "function"
    );
    // Standard Picture-in-Picture API — supported by Safari (macOS + iOS, including installed
    // PWAs) and Chromium since long before this was written; `disablePictureInPicture` is an
    // opt-out attribute we never set, so its absence needs no separate check.
    setPipSupported(typeof document !== "undefined" && document.pictureInPictureEnabled === true);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onPlaying);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onDuration);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("volumechange", onVolume);
      video.removeEventListener("ratechange", onRateChange);
      video.removeEventListener("enterpictureinpicture", onEnterPip);
      video.removeEventListener("leavepictureinpicture", onLeavePip);
    };
  }, [videoRef]);

  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [containerRef]);

  // Shows the controls and (re)starts the auto-hide — called directly from
  // interaction handlers rather than left to a visible-state-diffing effect,
  // since repeated taps while already visible wouldn't otherwise change
  // `visible` and so wouldn't reset the hide timer. Two tiers of delay: a
  // plain tap/hover on the video keeps the default 3s, while interacting with
  // any actual control (top-bar buttons, the audio/subtitle menus, the bottom
  // bar) passes 10s — reading through a track list takes longer than glancing
  // at the seek bar, and the old single 3s timer kept vanishing mid-read
  // (button handlers stopPropagation, so nothing was resetting it at all).
  // Only auto-hides while actually playing; paused stays visible indefinitely.
  // The hide also closes any open menu, so an expired timer can't leave an
  // invisible-but-clickable menu floating over the video.
  const showControls = useCallback(
    (delayMs: number = 3000) => {
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (playing) {
        hideTimer.current = setTimeout(() => {
          setVisible(false);
          setMenu(null);
        }, delayMs);
      }
    },
    [playing]
  );

  function hideControls() {
    setVisible(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }

  // For as long as a pointer is actually on the seek bar (hovering or dragging), controls must
  // never auto-hide at all — not even on a longer timer. Cancels any pending hide with nothing
  // to replace it; the hover/drag handlers below call showControls() again once the pointer
  // actually leaves or is released, restarting the normal countdown from a clean slate.
  function holdControls() {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }

  // Tap toggles explicitly (show <-> hide) again, without reintroducing the
  // Android bug: that bug was touch firing a synthetic mousemove right before
  // click, which forced visible=true a split second before the toggle read
  // it — so every tap net-cancelled itself. Fix is to stop treating touch
  // pointer movement as "show" at all (see onPointerMove below); once that
  // synthetic move no longer touches `visible`, click can safely toggle from
  // whatever the real current state is, for both mouse and touch.
  function toggleControls() {
    if (menu !== null) {
      setMenu(null);
      // The menu just closed from a tap outside it — controls stay up on the
      // normal short timer instead of the previous "no timer at all" (which
      // left them visible forever until another tap).
      showControls();
      return;
    }
    if (visible) hideControls();
    else showControls();
  }

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // showControls() does real effect work beyond setState (manages the auto-hide timeout ref),
  // so it can't move to a render-time adjustment. Called unconditionally on every playing
  // change — showControls() itself already only starts the hide timer when playing===true, so
  // this correctly both (a) kicks off the very first auto-hide once playback actually starts
  // (previously gated behind `if (!playing)`, which never re-fires showControls() for the
  // false->true transition — controls stayed visible forever until a manual tap) and
  // (b) forces controls back on with no timer when paused.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    showControls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  // Plain buttons only — deliberately not a double-tap-the-edge-of-the-screen gesture (easy to
  // trigger by accident, and conflicts with the tap-to-toggle-controls handler on the same area).
  function skip(deltaSeconds: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + deltaSeconds), duration || video.currentTime);
  }

  // Split in two: dragging the seek bar only moves the thumb/displayed time locally (no real
  // seek, no buffering triggered) until the pointer is released, which is when the actual seek
  // fires. Committing on every drag tick used to fire a real HTMLMediaElement seek on every
  // pixel of movement, each one triggering its own buffering/rebuffer cycle — which both felt
  // like the interface was fighting the drag and meant a quick "seek there, no wait, back" was
  // never actually free (every intermediate position had already been committed and buffered).
  function previewSeek(value: number) {
    setCurrentTime(value);
  }

  function commitSeek(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentTime(value);
  }

  // Trickplay scrubbing preview — fetched once per item, not per hover: it's item-wide static
  // metadata (grid layout + a handful of sprite-sheet tiles covering the whole runtime), so
  // there's nothing to re-fetch as the seek bar is dragged, only tiles to look up locally.
  const [trickplay, setTrickplay] = useState<{
    width: number; height: number; tileWidth: number; tileHeight: number; thumbnailCount: number; intervalMs: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jellyfin/trickplay/info?itemId=${itemId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setTrickplay(data);
      })
      .catch(() => {
        if (!cancelled) setTrickplay(null);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const seekBarRef = useRef<HTMLDivElement>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [previewFraction, setPreviewFraction] = useState(0);

  // Shared by mouse hover (desktop) and touch drag (mobile — there's no true hover there, so
  // this only actually renders while a touch is down, via the range input's own touch handling
  // reaching pointer move too) — both just need "where along the bar is the pointer". Plain
  // function, not useCallback: nothing needs its referential identity to stay stable, and the
  // extra state/hooks added alongside chapters/PiP/speed tripped the React Compiler's own
  // memoization-preservation check on the manually memoized version for reasons unrelated to
  // this function's own logic.
  function updatePreview(clientX: number) {
    const bar = seekBarRef.current;
    if (!bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setPreviewFraction(fraction);
    setPreviewTime(fraction * duration);
  }

  let previewTile: { url: string; bgX: number; bgY: number } | null = null;
  if (trickplay && previewTime !== null) {
    const thumbIndex = Math.min(
      trickplay.thumbnailCount - 1,
      Math.max(0, Math.floor((previewTime * 1000) / trickplay.intervalMs))
    );
    const perTile = trickplay.tileWidth * trickplay.tileHeight;
    const tileIndex = Math.floor(thumbIndex / perTile);
    const posInTile = thumbIndex % perTile;
    const row = Math.floor(posInTile / trickplay.tileWidth);
    const col = posInTile % trickplay.tileWidth;
    previewTile = {
      url: `/api/jellyfin/trickplay/tile?itemId=${itemId}&width=${trickplay.width}&index=${tileIndex}`,
      bgX: -(col * trickplay.width),
      bgY: -(row * trickplay.height),
    };
  }

  function toggleMute() {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }

  function changeVolume(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
  }

  async function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await el.requestFullscreen().catch(() => {});
    }
  }

  function showAirPlayPicker() {
    const video = videoRef.current as unknown as { webkitShowPlaybackTargetPicker?: () => void } | null;
    video?.webkitShowPlaybackTargetPicker?.();
  }

  // Native browser Picture-in-Picture — a real OS-level floating window, entirely separate from
  // our own custom mini-player (PlaybackProvider's "mini" mode). Deliberately never triggered
  // together: minimizing to our own PiP while native PiP is active would try to render our mini
  // player's chrome around a <video> the browser has already visually pulled out of the page,
  // so both onMinimize and onClose (below) exit native PiP first and wait for it before doing
  // anything else, rather than letting the two float independently.
  async function togglePip() {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      // Rejected (e.g. video not ready yet) — no error UI needed for an optional convenience.
    }
  }

  async function handleMinimizeClick() {
    if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {});
    onMinimize();
  }

  async function handleCloseClick() {
    if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {});
    onClose();
  }

  function changeSpeed(rate: number) {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
    setMenu(null);
  }

  function jumpToChapter(startSeconds: number) {
    commitSeek(startSeconds);
    setMenu(null);
  }

  // Space/arrows/M/F, full-mode only (this component isn't rendered in mini mode at all) and
  // skipped whenever an <input> already has focus — most relevantly the volume/seek range
  // sliders, which already have their own native arrow-key behavior that this would otherwise
  // fight over the exact same keys.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (document.activeElement instanceof HTMLInputElement) return;
      switch (e.code) {
        case "Space":
          e.preventDefault(); // default: page scroll
          togglePlay();
          showControls();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-10);
          showControls();
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(10);
          showControls();
          break;
        case "KeyM":
          toggleMute();
          break;
        case "KeyF":
          if (fullscreenSupported) toggleFullscreen();
          break;
        default:
          return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreenSupported]);

  if (hidden) return null;

  return (
    <div
      className="absolute inset-0 z-10"
      onClick={toggleControls}
      onPointerMove={(e) => {
        // Only real mouse hover implies "show" — a touch pointer fires a
        // synthetic move right before its click, which would otherwise force
        // visible=true a split second before the click's toggle reads it.
        if (e.pointerType === "mouse") showControls();
      }}
    >
      {/* Always visible regardless of the auto-hide controls fade below —
          otherwise a rebuffer that happens while controls are hidden looks
          like a silent freeze instead of a loading state. */}
      {(loading || buffering) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 size={40} className="animate-spin text-white/80" />
        </div>
      )}

      {/* Skip-intro and next-up prompts stay visible even when the rest of the
          controls have auto-hidden — they're time-sensitive, not navigation. */}
      {showSkipIntro && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (videoRef.current) videoRef.current.currentTime = introSkip!.end;
          }}
          className="pointer-events-auto absolute rounded-lg bg-white/15 px-4 py-2 text-sm font-medium text-white backdrop-blur-xs hover:bg-white/25"
          style={{
            bottom: "max(6rem, calc(env(safe-area-inset-bottom) + 5rem))",
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          Passer l&rsquo;intro
        </button>
      )}

      {showNextUp && nextEpisode && (
        <div
          className="pointer-events-auto absolute w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-slate-900/95 p-4 shadow-2xl ring-1 ring-white/10"
          style={{
            bottom: "max(6rem, calc(env(safe-area-inset-bottom) + 5rem))",
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          <p className="mb-1 text-xs text-slate-400">Épisode suivant · {nextUpCountdown}s</p>
          <p className="mb-3 truncate text-sm font-medium text-white">{nextEpisode.title}</p>
          <div className="flex gap-2">
            <button onClick={onAdvance} className="btn-primary flex-1 justify-center py-1.5 text-xs">
              Lire maintenant
            </button>
            <button
              onClick={() => setNextUpDismissed(true)}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <div
        className={`pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-black/60 via-transparent to-black/70 transition-opacity duration-300 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* Top bar — padded past the safe area so the close button isn't
            hidden under the notch / rounded corners in landscape PWA mode,
            plus extra clearance for the Dynamic Island / translucent status
            bar in portrait, which sits below the strict safe-area edge. */}
        <div
          className="pointer-events-auto flex items-center justify-between p-4"
          // Capture phase: children stopPropagation() in the bubble phase, which is exactly why
          // the old timer never got reset by button use — capture fires on the way DOWN, before
          // any child handler, so every top-bar interaction reliably re-arms the long timer.
          onClickCapture={() => showControls(10000)}
          style={{
            paddingTop: "max(1rem, calc(env(safe-area-inset-top) + 1.5rem))",
            paddingLeft: "max(1rem, env(safe-area-inset-left))",
            paddingRight: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          <p className="truncate pr-4 text-sm font-medium text-white">{title}</p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTogglePlaybackInfo();
              }}
              title="Playback Info"
              className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
            >
              <Info size={18} />
            </button>
            {subtitleTracks.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(menu === "subtitles" ? null : "subtitles");
                }}
                className={`rounded-lg p-2 text-white hover:bg-white/20 ${menu === "subtitles" ? "bg-white/20" : "bg-white/10"}`}
              >
                <Captions size={18} />
              </button>
            )}
            {audioTracks.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(menu === "audio" ? null : "audio");
                }}
                className={`rounded-lg p-2 text-white hover:bg-white/20 ${menu === "audio" ? "bg-white/20" : "bg-white/10"}`}
              >
                <AudioLines size={18} />
              </button>
            )}
            {chapters.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(menu === "chapters" ? null : "chapters");
                }}
                title="Chapitres"
                className={`rounded-lg p-2 text-white hover:bg-white/20 ${menu === "chapters" ? "bg-white/20" : "bg-white/10"}`}
              >
                <ListVideo size={18} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === "speed" ? null : "speed");
              }}
              title="Vitesse de lecture"
              className={`rounded-lg p-2 text-white hover:bg-white/20 ${menu === "speed" ? "bg-white/20" : "bg-white/10"}`}
            >
              <Gauge size={18} />
            </button>
            {airPlaySupported && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  showAirPlayPicker();
                }}
                className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
              >
                <Cast size={18} />
              </button>
            )}
            {pipSupported && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePip();
                }}
                title="Picture-in-picture"
                className={`rounded-lg p-2 text-white hover:bg-white/20 ${pipActive ? "bg-white/20" : "bg-white/10"}`}
              >
                <PictureInPicture2 size={18} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMinimizeClick();
              }}
              title="Réduire"
              className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
            >
              <ChevronDown size={20} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCloseClick();
              }}
              className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {menu && (
          <div
            className="pointer-events-auto absolute w-56 max-h-[60vh] overflow-y-auto overscroll-contain rounded-lg bg-slate-900/95 shadow-2xl ring-1 ring-white/10"
            style={{
              // `bottom` deliberately not set here: an absolutely-positioned element with both
              // `top` and `bottom` stretches to fill the space between them regardless of
              // content — which made this menu always ~half the screen tall even with only 2-3
              // items. `max-h-[60vh]` alone already caps growth for a long track list; the menu
              // otherwise just sizes to its content.
              top: "max(4rem, calc(env(safe-area-inset-top) + 5rem))",
              right: "max(1rem, env(safe-area-inset-right))",
            }}
            onClick={(e) => e.stopPropagation()}
            onClickCapture={() => showControls(10000)}
          >
            {(menu === "audio" || menu === "subtitles") &&
              (menu === "audio" ? audioTracks : subtitleTracks).map((tr) => (
                <button
                  key={tr.id}
                  onClick={() => {
                    if (menu === "audio") onChangeAudio(tr.id);
                    else onChangeSubtitle(tr.id);
                    setMenu(null);
                  }}
                  className={`block w-full truncate px-3 py-2 text-left text-sm hover:bg-white/10 ${
                    (menu === "audio" ? currentAudioId : currentSubtitleId) === tr.id ? "text-accent-400" : "text-white"
                  }`}
                >
                  {tr.label}
                </button>
              ))}
            {menu === "subtitles" && (
              <button
                onClick={() => {
                  onChangeSubtitle(null);
                  setMenu(null);
                }}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-white/10 ${
                  currentSubtitleId === null ? "text-accent-400" : "text-white"
                }`}
              >
                Aucun
              </button>
            )}
            {menu === "speed" &&
              PLAYBACK_SPEEDS.map((rate) => (
                <button
                  key={rate}
                  onClick={() => changeSpeed(rate)}
                  className={`block w-full px-3 py-2 text-left text-sm hover:bg-white/10 ${
                    speed === rate ? "text-accent-400" : "text-white"
                  }`}
                >
                  {rate === 1 ? "Normale" : `${rate}x`}
                </button>
              ))}
            {menu === "chapters" &&
              chapters.map((ch, i) => (
                <button
                  key={i}
                  onClick={() => jumpToChapter(ch.start)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-white/10 ${
                    currentTime >= ch.start && (chapters[i + 1] ? currentTime < chapters[i + 1].start : true)
                      ? "text-accent-400"
                      : "text-white"
                  }`}
                >
                  <span className="truncate">{ch.name}</span>
                  <span className="shrink-0 tabular-nums text-white/50">{formatTime(ch.start)}</span>
                </button>
              ))}
          </div>
        )}

        {/* Center play/pause, flanked by ±10s skip buttons — plain buttons only, not a
            double-tap-the-screen-edge gesture (too easy to trigger by accident, and would
            conflict with the tap-to-toggle-controls handler covering the same area). Hidden
            while a spinner is already showing. */}
        {!loading && !buffering && (
          <div className="pointer-events-auto absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-6">
            <button
              onClick={(e) => {
                e.stopPropagation();
                skip(-10);
              }}
              className="rounded-full bg-black/40 p-3 text-white hover:bg-black/60"
              title="Reculer de 10s"
            >
              <RotateCcw size={22} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
              className="rounded-full bg-black/40 p-4 text-white hover:bg-black/60"
            >
              {playing ? <Pause size={28} /> : <Play size={28} />}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                skip(10);
              }}
              className="rounded-full bg-black/40 p-3 text-white hover:bg-black/60"
              title="Avancer de 10s"
            >
              <RotateCw size={22} />
            </button>
          </div>
        )}

        {/* Bottom bar */}
        <div
          className="pointer-events-auto flex flex-col gap-2 p-4"
          onClick={(e) => e.stopPropagation()}
          onClickCapture={() => showControls(10000)}
          style={{
            paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
            paddingLeft: "max(1rem, env(safe-area-inset-left))",
            paddingRight: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          <div
            ref={seekBarRef}
            className="relative"
            // Same treatment as the top-bar buttons (see showControls' comment) but stronger:
            // holdControls() suspends auto-hide entirely for as long as the pointer is anywhere
            // on the bar — hovering to preview a thumbnail, or dragging — rather than merely
            // extending the timer, since a 10s cap could still expire mid-read on a long scrub.
            // The normal countdown only resumes once the pointer actually leaves or is released.
            onMouseEnter={holdControls}
            onMouseMove={(e) => {
              holdControls();
              updatePreview(e.clientX);
            }}
            onMouseLeave={() => {
              setPreviewTime(null);
              if (!seekingRef.current) showControls(5000);
            }}
            onTouchStart={(e) => {
              holdControls();
              updatePreview(e.touches[0].clientX);
            }}
            onTouchMove={(e) => {
              holdControls();
              updatePreview(e.touches[0].clientX);
            }}
          >
            {/* Chapter markers — visual only, not independently clickable: the seek bar's own
                drag already covers the whole track, so a second, narrower hit target right on
                top of it would only make small drag corrections more error-prone. Jumping to a
                specific chapter is what the chapters menu button is for. */}
            {duration > 0 &&
              chapters.map((ch, i) => (
                <div
                  key={i}
                  className="pointer-events-none absolute top-0 h-1 w-px bg-black/50"
                  style={{ left: `${(ch.start / duration) * 100}%` }}
                />
              ))}
            {previewTime !== null && (
              <div
                className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 overflow-hidden rounded-md bg-black shadow-xl ring-1 ring-white/20"
                style={{
                  left: `${previewFraction * 100}%`,
                  width: trickplay?.width ?? 160,
                  height: trickplay?.height ?? 90,
                }}
              >
                {previewTile && (
                  <div
                    className="h-full w-full"
                    style={{
                      backgroundImage: `url(${previewTile.url})`,
                      backgroundPosition: `${previewTile.bgX}px ${previewTile.bgY}px`,
                      // Sized to the FULL sprite sheet, not one tile slot — a plain background
                      // shorthand size here would stretch the whole sheet into one thumbnail's
                      // box instead of just positioning the correct slot within it.
                      backgroundSize: `${(trickplay!.width * trickplay!.tileWidth)}px ${(trickplay!.height * trickplay!.tileHeight)}px`,
                    }}
                  />
                )}
                <p className="absolute inset-x-0 bottom-0 bg-black/70 py-0.5 text-center text-[11px] tabular-nums text-white">
                  {formatTime(previewTime)}
                </p>
              </div>
            )}
            <input
              type="range"
              min={0}
              max={duration || 0}
              value={currentTime}
              // Every intermediate value while dragging is a preview only (see previewSeek) —
              // native range inputs fire 'input'/onChange continuously during a drag, not just
              // on release, so onChange alone can't distinguish "still dragging" from "done".
              // mousedown/touchstart mark the start of a drag; mouseup/touchend (native pointer
              // capture keeps these firing on the input even if the pointer wanders outside its
              // bounds) commit the FINAL value as one real seek and let auto-hide resume after 5s.
              onChange={(e) => previewSeek(Number(e.target.value))}
              onMouseDown={() => {
                seekingRef.current = true;
                holdControls();
              }}
              onTouchStart={() => {
                seekingRef.current = true;
                holdControls();
              }}
              // The 5s call is deferred a tick: mouseup/touchend is immediately followed by a
              // synchronous 'click' event, which the bottom bar's own onClickCapture (see its
              // comment) answers with a flat 10s for every other control there — since capture
              // fires on that ancestor before this handler's own effect could otherwise "stick",
              // running after the click's synchronous dispatch has already finished is what
              // makes 5s the one that actually wins, per what was asked for here specifically.
              onMouseUp={(e) => {
                seekingRef.current = false;
                commitSeek(Number((e.target as HTMLInputElement).value));
                setTimeout(() => showControls(5000), 0);
              }}
              onTouchEnd={(e) => {
                seekingRef.current = false;
                commitSeek(Number((e.target as HTMLInputElement).value));
                setPreviewTime(null);
                setTimeout(() => showControls(5000), 0);
              }}
              className="h-1 w-full cursor-pointer accent-accent-500"
            />
          </div>
          <div className="flex items-center gap-3 text-xs text-white/80">
            <span className="tabular-nums">{formatTime(currentTime)}</span>
            <span className="text-white/40">/</span>
            <span className="tabular-nums">{formatTime(duration)}</span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={toggleMute} className="rounded-lg p-1.5 hover:bg-white/10">
                {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => changeVolume(Number(e.target.value))}
                className="h-1 w-16 cursor-pointer accent-accent-500"
              />
              {fullscreenSupported && (
                <button onClick={toggleFullscreen} className="rounded-lg p-1.5 hover:bg-white/10">
                  {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

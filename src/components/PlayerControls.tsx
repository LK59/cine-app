"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, X, Captions, AudioLines, Cast, Loader2, ChevronDown, Info } from "lucide-react";

export interface Track {
  id: number;
  label: string;
}

interface PlayerControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
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
  const [menu, setMenu] = useState<null | "audio" | "subtitles">(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [airPlaySupported, setAirPlaySupported] = useState(false);
  const [nextUpDismissed, setNextUpDismissed] = useState(false);
  const [nextUpCountdown, setNextUpCountdown] = useState(NEXT_UP_COUNTDOWN_S);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(video.currentTime);
    const onDuration = () => setDuration(video.duration || 0);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onDuration);
    video.addEventListener("durationchange", onDuration);
    video.addEventListener("volumechange", onVolume);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    // Safari-only API — feature-detected, not part of the standard HTMLVideoElement type.
    setAirPlaySupported(
      typeof (video as unknown as { webkitShowPlaybackTargetPicker?: unknown })
        .webkitShowPlaybackTargetPicker === "function"
    );
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onDuration);
      video.removeEventListener("durationchange", onDuration);
      video.removeEventListener("volumechange", onVolume);
    };
  }, [videoRef]);

  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [containerRef]);

  // Shows the controls and (re)starts the 3s auto-hide — called directly from
  // interaction handlers rather than left to a visible-state-diffing effect,
  // since repeated taps while already visible wouldn't otherwise change
  // `visible` and so wouldn't reset the hide timer (only playing/menu changes
  // would). Only auto-hides while actually playing with no menu open —
  // paused/menu-open states stay visible indefinitely.
  const showControls = useCallback(() => {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing && menu === null) {
      hideTimer.current = setTimeout(() => setVisible(false), 3000);
    }
  }, [playing, menu]);

  function hideControls() {
    setVisible(false);
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

  function seek(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentTime(value);
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
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMinimize();
              }}
              title="Réduire"
              className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
            >
              <ChevronDown size={20} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
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
              top: "max(4rem, calc(env(safe-area-inset-top) + 5rem))",
              right: "max(1rem, env(safe-area-inset-right))",
              bottom: "max(1rem, env(safe-area-inset-bottom))",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {(menu === "audio" ? audioTracks : subtitleTracks).map((tr) => (
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
          </div>
        )}

        {/* Center play/pause — hidden while a spinner is already showing */}
        {!loading && !buffering && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/40 p-4 text-white hover:bg-black/60"
          >
            {playing ? <Pause size={28} /> : <Play size={28} />}
          </button>
        )}

        {/* Bottom bar */}
        <div
          className="pointer-events-auto flex flex-col gap-2 p-4"
          onClick={(e) => e.stopPropagation()}
          style={{
            paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
            paddingLeft: "max(1rem, env(safe-area-inset-left))",
            paddingRight: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={currentTime}
            onChange={(e) => seek(Number(e.target.value))}
            className="h-1 w-full cursor-pointer accent-accent-500"
          />
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

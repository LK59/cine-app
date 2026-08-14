"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { PlayerControls, type Track } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { PlaybackInfoPanel } from "@/components/PlaybackInfoPanel";
import { usePlayback } from "@/components/PlaybackProvider";
import { detectCodecSupport } from "@/lib/codecSupport";

export type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";

export interface PlaybackInfoSummary {
  playMethod: PlayMethod;
  transcodeReasons: string[];
  container: string | null;
  requestedVideoCodecs: string[];
  video: {
    codec: string | null;
    profile: string | null;
    width: number | null;
    height: number | null;
    bitDepth: number | null;
    frameRate: number | null;
    bitRate: number | null;
  } | null;
  audio: {
    codec: string | null;
    channels: number | null;
    bitRate: number | null;
    language: string | null;
  } | null;
}

interface ExternalSubtitleTrack {
  index: number;
  url: string;
  label: string;
  language?: string;
  isDefault: boolean;
}

// This is sent as Jellyfin's MaxStreamingBitrate, which gates BOTH the "is this source's own
// bitrate low enough to DirectPlay/DirectStream" check AND the fallback transcode's output
// target. The previous tiers (4/8/15 Mbps by viewport) were sized for the old always-transcode
// model, where a lower cap kept re-encode load down — but a real remux Blu-ray FHD HEVC file
// routinely runs 15-25+ Mbps, well above the old 8 Mbps FHD tier. With that cap in place,
// Jellyfin rejected DirectStream (container/audio-only remux, no video re-encode) purely on
// bitrate and fell back to a bitrate-constrained HEVC re-encode instead — much heavier, and the
// likely cause of a "La lecture a été interrompue" hls.js failure observed on a real FHD file.
// Raised well above any realistic home-media bitrate so codec/container compatibility (not an
// arbitrary bandwidth guess) is what actually decides DirectPlay/DirectStream vs Transcode; a
// genuine Transcode still targets a bounded output via Jellyfin's own encoding defaults.
// No mid-playback renegotiation for resolution (accepted tradeoff — see plan).
const MAX_NETWORK_RETRIES = 6;
const MAX_MEDIA_RETRIES = 3;

function pickMaxBitrate(): number {
  const w = window.innerWidth * (window.devicePixelRatio || 1);
  if (w <= 1280) return 20_000_000;
  if (w <= 1920) return 40_000_000;
  return 100_000_000;
}

// The single, always-mounted playback engine for the whole app (mounted once in the
// dashboard layout) — driven by PlaybackProvider's global state instead of props, so it
// survives navigating to a different page. Renders nothing when there's no active session;
// otherwise renders the SAME <video> element regardless of full/mini mode (only the
// container's size/position/chrome differ), so minimizing never interrupts playback.
export function PlayerHost() {
  const playback = usePlayback();
  const { session, mode } = playback;

  if (!session) return null;
  return <ActivePlayer session={session} mode={mode === "mini" ? "mini" : "full"} />;
}

function ActivePlayer({
  session,
  mode,
}: {
  session: NonNullable<ReturnType<typeof usePlayback>["session"]>;
  mode: "full" | "mini";
}) {
  const playback = usePlayback();
  const { itemId, title, resumeAt: initialResumeAt } = session;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const networkRetryCount = useRef(0);
  const mediaRetryCount = useRef(0);
  const networkRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept up to date on every 'timeupdate' so a fatal error (which freezes the <video> in
  // place, no longer receiving new data) still has a recent position to resume from — reading
  // video.currentTime directly at that point would work too, but this is more robust if the
  // element itself is ever swapped.
  const lastKnownTime = useRef(0);
  const loadWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [loading, setLoading] = useState(true);
  // True only while hls.js is mid-retry after a fatal network/media error — distinct from
  // `loading` (the initial "fetching a fresh manifest" spinner) and from `error` (retries
  // exhausted, playback truly stopped). Drives the small non-blocking "Reconnexion..." banner.
  const [reconnecting, setReconnecting] = useState(false);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [closing, setClosing] = useState(false);
  const [playSession, setPlaySession] = useState<{
    itemId: string;
    playSessionId: string;
    mediaSourceId: string;
  } | null>(null);

  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [currentAudioId, setCurrentAudioId] = useState<number | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<Track[]>([]);
  const [currentSubtitleId, setCurrentSubtitleId] = useState<number | null>(null);
  const [introSkip, setIntroSkip] = useState<{ start: number; end: number } | null>(null);
  const [creditsStart, setCreditsStart] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [externalSubtitleTracks, setExternalSubtitleTracks] = useState<ExternalSubtitleTrack[]>([]);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfoSummary | null>(null);
  const [showPlaybackInfo, setShowPlaybackInfo] = useState(false);
  const playMethod = playbackInfo?.playMethod ?? "Transcode";

  const stopPlaybackNow = usePlaybackSession(
    useCallback(() => lastKnownTime.current, []),
    playSession && { ...playSession, playMethod }
  );

  const nextEpisode = session.getNextEpisode?.(itemId) ?? null;

  // Swaps to the next episode in place — reports the current one's final
  // position first, same as a manual close, but never triggers the
  // close/unmount fade since the player stays open for the new episode.
  const handleAdvance = useCallback(() => {
    if (!nextEpisode) return;
    stopPlaybackNow();
    playback.advance(nextEpisode);
  }, [nextEpisode, playback, stopPlaybackNow]);

  // Fades out instead of vanishing instantly — an abrupt unmount back to the
  // underlying page reads as a glitch, especially mid-transcode. Reports the
  // stop position right now (not whenever React gets around to unmounting)
  // so Jellyfin's resume point reflects the exact moment the user closed,
  // not wherever currentTime drifts to during the fade delay.
  const CLOSE_MS = 200;
  const handleClose = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    stopPlaybackNow();
    setClosing(true);
    setTimeout(() => playback.close(), CLOSE_MS);
  }, [playback, stopPlaybackNow]);

  useEffect(() => {
    if (mode !== "full") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, handleClose]);

  // (Re)starts playback, optionally at a specific audio track / resume point.
  // Jellyfin only ever transcodes ONE audio stream into the HLS output (unlike
  // subtitles, which it exposes as switchable renditions), so changing audio
  // means asking for a brand new transcode. Jellyfin's HLS output here is a
  // full VOD playlist covering the whole runtime regardless of StartTimeTicks
  // (seeking already works by jumping within it) — so instead of trusting
  // Jellyfin to start the new stream at the right offset, we seek the video
  // to resumeAt ourselves once the new manifest's metadata is ready.
  const startPlayback = useCallback(
    async (opts?: { audioStreamIndex?: number; resumeAt?: number }) => {
      const video = videoRef.current;
      if (!video) return;

      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
      networkRetryTimer.current = null;
      if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
      loadWatchdog.current = null;
      networkRetryCount.current = 0;
      mediaRetryCount.current = 0;
      setError(null);
      setReconnecting(false);
      setLoading(true);

      // Root cause found live: on Safari (desktop + iOS PWA), reassigning `video.src` straight
      // to a brand new manifest while the element still has an old native-HLS source attached
      // (e.g. switching audio track mid-playback) throws an immediate native "error" event —
      // verified against real Jellyfin logs during a live test: the server-side ffmpeg remux job
      // for the new audio track launched and ran cleanly every time (no server error at all),
      // it was only ever torn down a few seconds later by our own client after Safari had
      // already failed. Firefox/hls.js never hit this because hls.js already tears its own
      // MediaSource down internally before attaching a new one.
      //
      // A first attempt (synchronous pause + removeAttribute + load) wasn't enough — verified
      // the *manifest itself* is fine (fetched it directly for both audio tracks via Jellyfin's
      // API: well-formed, identical shape to an initial load that already works), so the
      // remaining flakiness is really about timing: WebKit's AVPlayer-backed pipeline doesn't
      // finish tearing down synchronously within the same tick. Now actually waits for the
      // "emptied" event (with a bounded fallback delay, since "emptied" isn't guaranteed to fire
      // in every engine/version) before the new source is assigned, giving WebKit a real turn of
      // the event loop to finish flushing the old session first.
      if (video.src) {
        video.pause();
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            video.removeEventListener("emptied", finish);
            resolve();
          };
          video.addEventListener("emptied", finish, { once: true });
          video.removeAttribute("src");
          video.load();
          setTimeout(finish, 300);
        });
      }

      const codecSupport = await detectCodecSupport();

      const res = await fetch("/api/jellyfin/playback/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          maxBitrate: pickMaxBitrate(),
          audioStreamIndex: opts?.audioStreamIndex,
          startTicks: opts?.resumeAt ? Math.floor(opts.resumeAt * 10_000_000) : undefined,
          codecSupport,
        }),
      });
      if (res.status === 401) {
        const body = await res.json().catch(() => null);
        if (body?.code === "jellyfin_reauth_required") {
          setNeedsReauth(true);
          setLoading(false);
          return;
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || "Lecture impossible pour le moment.");
        setLoading(false);
        return;
      }
      const data = await res.json();

      setPlaySession({ itemId, playSessionId: data.playSessionId, mediaSourceId: data.mediaSourceId });
      setAudioTracks(
        (data.audioTracks ?? []).map((t: { index: number; label: string }) => ({
          id: t.index,
          label: t.label,
        }))
      );
      setCurrentAudioId(opts?.audioStreamIndex ?? data.audioTracks?.find((t: { isDefault: boolean }) => t.isDefault)?.index ?? null);
      setIntroSkip(data.introSkip ?? null);
      setCreditsStart(data.creditsStart ?? null);
      setPlaybackInfo(data.playbackInfo ?? null);

      const resumeAt = opts?.resumeAt;
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
          loadWatchdog.current = null;
          if (resumeAt) video.currentTime = resumeAt;
          // Seeded here rather than waiting for the first 'timeupdate' — otherwise a progress
          // heartbeat firing in the gap right after a resume would still report the pre-seek 0.
          lastKnownTime.current = resumeAt ?? 0;
          setLoading(false);
        },
        { once: true }
      );

      // Last-resort safety net alongside the "error" event listener above: covers the case
      // where the manifest/segment request itself hangs (through our own stream proxy) without
      // ever firing a native error OR an hls.js fatal — nothing to recover from, so this just
      // turns a silent infinite spinner into an actionable error with a retry button.
      loadWatchdog.current = setTimeout(() => {
        setReconnecting(false);
        setLoading(false);
        setError("Le chargement prend trop de temps. Réessaie.");
      }, 20_000);

      // Subtitles always come from the PlaybackInfo response as external VTT tracks (rendered
      // as <track> elements below), for every PlayMethod — not from hls.js's own
      // SUBTITLE_TRACKS_UPDATED event or native textTrack discovery. Those turned out both
      // *less* reliable (hls.js's own rendition names are often blank, falling back to generic
      // "Piste N") AND actively harmful here: since they fire asynchronously after this rich
      // list is already set, they'd silently overwrite it a moment later. Real-world catalog
      // check: DirectStream (an mkv container remuxed to HLS, video copied untouched) is the
      // dominant case for an HEVC-in-mkv library, not the exception — so this isn't a narrow
      // DirectPlay-only fix, it's the primary path.
      const tracks: ExternalSubtitleTrack[] = (data.subtitleTracks ?? []).map(
        (t: { index: number; url: string; label: string; language?: string; isDefault: boolean }) => t
      );
      setExternalSubtitleTracks(tracks);
      setSubtitleTracks(tracks.map((t) => ({ id: t.index, label: t.label })));
      setCurrentSubtitleId(null);

      // DirectPlay/DirectStream: a plain Range-seekable file, not an HLS manifest — no hls.js,
      // no native-HLS branch below, just a regular <video src>.
      if (data.isDirectPlay) {
        video.src = data.manifestUrl;
        video.load();
        video.play().catch(() => {});
        return;
      }

      // Safari (desktop + iOS) plays HLS natively — hls.js is only needed where
      // that's absent (Chrome/Firefox).
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = data.manifestUrl;
        // Reassigning .src alone doesn't reliably tear down Safari's existing
        // HLS session when only the query string changes (e.g. switching
        // audio track) — force a clean reload so it actually picks up the
        // new manifest instead of silently continuing the old one.
        video.load();
        video.play().catch(() => {});
        return;
      }

      const { default: Hls } = await import("hls.js");
      if (!Hls.isSupported()) {
        setError("Ce navigateur ne peut pas lire ce flux.");
        setLoading(false);
        return;
      }
      const hls = new Hls({
        // hls.js's own default back-buffer behavior varies by version and isn't
        // worth trusting blindly — pin it explicitly so a -30s rewind replays
        // from the already-decoded buffer instead of stalling on a re-fetch.
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 90,
      });
      hlsRef.current = hls;

      // A successfully buffered fragment means the stream is healthy again — reset both
      // counters so a later, unrelated blip gets its own full retry budget instead of
      // inheriting an exhausted one from an earlier, already-recovered outage.
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        networkRetryCount.current = 0;
        mediaRetryCount.current = 0;
        setReconnecting(false);
      });

      // hls.js's own per-request retry/backoff (fragLoadingMaxRetry etc.) already absorbs a
      // short stall before ever raising a *fatal* error — a fatal here means that budget is
      // already exhausted. hls.js's documented recovery for that case is to call startLoad()
      // (network) or recoverMediaError() (media) ourselves rather than tearing the player down;
      // bounded so a genuinely dead stream still surfaces an error instead of retrying forever.
      hls.on(Hls.Events.ERROR, (_evt, data2) => {
        if (!data2.fatal) return;
        switch (data2.type) {
          case Hls.ErrorTypes.NETWORK_ERROR: {
            if (networkRetryCount.current >= MAX_NETWORK_RETRIES) {
              setReconnecting(false);
              setLoading(false);
              setError("La lecture a été interrompue. Vérifie ta connexion et réessaie.");
              return;
            }
            networkRetryCount.current += 1;
            setReconnecting(true);
            // Exponential backoff (1s, 2s, 4s... capped at 15s) — covers a brief network
            // handoff (e.g. mobile switching between 5G and Wi-Fi, which drops connectivity
            // for roughly 1-3s) without hammering the server if it's actually down.
            const delay = Math.min(1000 * 2 ** (networkRetryCount.current - 1), 15_000);
            if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
            networkRetryTimer.current = setTimeout(() => hls.startLoad(), delay);
            return;
          }
          case Hls.ErrorTypes.MEDIA_ERROR: {
            if (mediaRetryCount.current >= MAX_MEDIA_RETRIES) {
              setReconnecting(false);
              setLoading(false);
              setError("La lecture a été interrompue. Réessaie.");
              return;
            }
            mediaRetryCount.current += 1;
            setReconnecting(true);
            hls.recoverMediaError();
            return;
          }
          default:
            setReconnecting(false);
            setLoading(false);
            setError("La lecture a été interrompue. Réessaie.");
        }
      });
      hls.loadSource(data.manifestUrl);
      hls.attachMedia(video);
    },
    [itemId]
  );

  const changeAudio = useCallback(
    (id: number) => {
      const resumeAt = videoRef.current?.currentTime ?? 0;
      startPlayback({ audioStreamIndex: id, resumeAt });
    },
    [startPlayback]
  );

  // Manual "Réessayer" after retries are exhausted and `error` is showing — a full re-fetch
  // of PlaybackInfo (not just hls.startLoad()) since the old PlaySessionId/manifest may itself
  // be stale by then, picking up from the last position we saw before the stream died.
  const handleRetry = useCallback(() => {
    startPlayback({ resumeAt: lastKnownTime.current });
  }, [startPlayback]);

  // Always toggles the native <track> elements rendered from externalSubtitleTracks below —
  // regardless of PlayMethod, since subtitles are now uniformly external VTT (see startPlayback).
  // video.textTracks is indexed by DOM position, not by Jellyfin's own stream index (`id`
  // here), so the position has to be looked up in externalSubtitleTracks (rendered in the same
  // order) rather than assuming textTracks[id].
  const changeSubtitle = useCallback((id: number | null) => {
    const video = videoRef.current;
    if (!video) return;
    const position = id === null ? -1 : externalSubtitleTracks.findIndex((t) => t.index === id);
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = i === position ? "showing" : "disabled";
    }
    setCurrentSubtitleId(id);
  }, [externalSubtitleTracks]);

  // Kicks off async playback setup (fetch + hls.js wiring) on mount — real effect work, not a
  // simple state derivation, so it can't move to render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    startPlayback({ resumeAt: initialResumeAt });
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
      networkRetryTimer.current = null;
      if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
      loadWatchdog.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPlayback]);

  // Ends playback entirely (not just minimize) when the video finishes — same in both modes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    function onEnded() {
      handleClose();
    }
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [handleClose]);

  // Tracked independently of PlayerControls (which keeps its own copy for the full-mode UI)
  // so the mini player's play/pause icon stays correct without threading state through props.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      lastKnownTime.current = video.currentTime;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, []);

  // The native <video> "error" event is the ONLY failure signal for the DirectPlay and native
  // Safari-HLS paths (both are a plain `video.src = manifestUrl`, no hls.js involved, so none of
  // the Hls.Events.ERROR retry/recovery logic above ever applies to them). Nothing was listening
  // for it at all — a genuine failure there (e.g. Jellyfin failing to build a remux session for a
  // newly requested audio track) left `loading` stuck at `true` forever, an infinite spinner with
  // no way out. code 1 (MEDIA_ERR_ABORTED) is excluded: it fires as an expected side effect of
  // every deliberate `video.src = ...; video.load()` reassignment in startPlayback itself
  // (switching audio/subtitle, retrying) aborting whatever the previous src was doing — not a
  // real failure, and treating it as one would surface a false error on every track switch.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    function onError() {
      if (video!.error?.code === MediaError.MEDIA_ERR_ABORTED) return;
      setReconnecting(false);
      setLoading(false);
      setError("La lecture a été interrompue. Réessaie.");
    }
    video.addEventListener("error", onError);
    return () => video.removeEventListener("error", onError);
  }, []);

  // Browser-level connectivity, independent of hls.js's own retry state — shows the "Vous êtes
  // hors ligne" banner immediately on disconnect (like YouTube), rather than waiting for a
  // fragment request to actually time out and surface as a network error first.
  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const handleExpand = useCallback(() => playback.expand(), [playback]);
  const { pos, size, isDragging, handlers } = useMiniPlayerDrag(mode === "mini", handleExpand);

  function toggleMiniPlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  if (typeof document === "undefined") return null;

  const isMini = mode === "mini";
  const TRANSITION = "top 300ms cubic-bezier(0.4,0,0.2,1), left 300ms cubic-bezier(0.4,0,0.2,1), width 300ms cubic-bezier(0.4,0,0.2,1), height 300ms cubic-bezier(0.4,0,0.2,1), border-radius 300ms cubic-bezier(0.4,0,0.2,1)";

  const style: React.CSSProperties = isMini
    ? {
        position: "fixed",
        top: pos.y,
        left: pos.x,
        width: size.width,
        height: size.height,
        borderRadius: 16,
        zIndex: 80,
        overflow: "hidden",
        boxShadow: "0 10px 30px rgba(0,0,0,.5)",
        transition: isDragging ? "none" : TRANSITION,
        touchAction: "none",
      }
    : {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100dvh",
        borderRadius: 0,
        zIndex: 80,
        background: "black",
        transition: `${TRANSITION}, opacity 200ms ease-out`,
        opacity: closing ? 0 : 1,
      };

  return createPortal(
    <div ref={containerRef} style={style} className={isMini ? "animate-fade-in-scale" : ""} {...(isMini ? handlers : {})}>
      {needsReauth ? (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div>
            <p className="mb-4 text-sm text-white">Ta session Jellyfin a expiré.</p>
            <a
              href={`/login?reason=playback&next=${encodeURIComponent(window.location.pathname)}`}
              className="btn-primary inline-flex justify-center"
            >
              Se reconnecter
            </a>
          </div>
        </div>
      ) : (
        <>
          {/* Kept mounted even while `error` is showing, so `lastKnownTime`/hls state aren't
              lost and "Réessayer" can resume from where playback actually stopped, instead of
              from the beginning. */}
          <video
            ref={videoRef}
            playsInline
            autoPlay
            className={isMini ? "h-full w-full object-cover" : "h-full w-full"}
            {...{ "x-webkit-airplay": "allow" }}
          >
            {externalSubtitleTracks.map((t) => (
              <track key={t.index} kind="subtitles" src={t.url} srcLang={t.language} label={t.label} />
            ))}
          </video>
          {error && !isMini && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6 text-center">
              <div>
                <p className="mb-4 text-sm text-red-400">{error}</p>
                <div className="flex justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20"
                  >
                    Quitter
                  </button>
                  <button type="button" onClick={handleRetry} className="btn-primary inline-flex justify-center">
                    Réessayer
                  </button>
                </div>
              </div>
            </div>
          )}
          {!error && !isMini && (isOffline || reconnecting) && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-[max(1rem,env(safe-area-inset-bottom))]">
              <div className="rounded-full bg-black/80 px-4 py-1.5 text-xs text-white shadow-lg ring-1 ring-white/10">
                {isOffline ? "Vous êtes hors ligne" : "Reconnexion…"}
              </div>
            </div>
          )}
        </>
      )}
      {!isMini && (
        <PlayerControls
          videoRef={videoRef}
          containerRef={containerRef}
          title={title}
          onClose={handleClose}
          onMinimize={playback.minimize}
          onTogglePlaybackInfo={() => setShowPlaybackInfo((v) => !v)}
          audioTracks={audioTracks}
          currentAudioId={currentAudioId}
          onChangeAudio={changeAudio}
          subtitleTracks={subtitleTracks}
          currentSubtitleId={currentSubtitleId}
          onChangeSubtitle={changeSubtitle}
          hidden={!!error || needsReauth}
          loading={loading}
          introSkip={introSkip}
          creditsStart={creditsStart}
          nextEpisode={nextEpisode}
          onAdvance={handleAdvance}
        />
      )}
      {!isMini && (
        <PlaybackInfoPanel info={playbackInfo} open={showPlaybackInfo} onClose={() => setShowPlaybackInfo(false)} />
      )}
      {isMini && !error && !needsReauth && (
        <MiniPlayerChrome title={title} playing={playing} onTogglePlay={toggleMiniPlay} onClose={handleClose} />
      )}
    </div>,
    document.body
  );
}

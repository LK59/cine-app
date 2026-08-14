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

  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [loading, setLoading] = useState(true);
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
  const [isDirectPlay, setIsDirectPlay] = useState(false);
  const [externalSubtitleTracks, setExternalSubtitleTracks] = useState<ExternalSubtitleTrack[]>([]);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfoSummary | null>(null);
  const [showPlaybackInfo, setShowPlaybackInfo] = useState(false);
  const playMethod = playbackInfo?.playMethod ?? "Transcode";

  const stopPlaybackNow = usePlaybackSession(videoRef, playSession && { ...playSession, playMethod });

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

  function readNativeSubtitles(video: HTMLVideoElement) {
    const tracks: Track[] = [];
    let activeId: number | null = null;
    for (let i = 0; i < video.textTracks.length; i++) {
      const t = video.textTracks[i];
      if (t.kind !== "subtitles" && t.kind !== "captions") continue;
      tracks.push({ id: i, label: t.label || t.language || `Piste ${i + 1}` });
      if (t.mode === "showing") activeId = i;
    }
    if (tracks.length) {
      setSubtitleTracks(tracks);
      setCurrentSubtitleId(activeId);
    }
  }

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
      setLoading(true);

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
      setIsDirectPlay(!!data.isDirectPlay);

      const resumeAt = opts?.resumeAt;
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (resumeAt) video.currentTime = resumeAt;
          setLoading(false);
        },
        { once: true }
      );

      // DirectPlay/DirectStream: a plain Range-seekable file, not an HLS manifest — no hls.js,
      // no native-HLS branch below, just a regular <video src>. Subtitles come from the
      // PlaybackInfo response as external VTT tracks (see the <track> elements rendered below)
      // rather than from hls.js/native textTrack discovery, since there's no HLS rendition and
      // the browser can't demux an mkv's embedded subtitle tracks on its own.
      if (data.isDirectPlay) {
        const tracks: ExternalSubtitleTrack[] = (data.subtitleTracks ?? []).map(
          (t: { index: number; url: string; label: string; language?: string; isDefault: boolean }) => t
        );
        setExternalSubtitleTracks(tracks);
        setSubtitleTracks(tracks.map((t) => ({ id: t.index, label: t.label })));
        setCurrentSubtitleId(null);
        video.src = data.manifestUrl;
        video.load();
        video.play().catch(() => {});
        return;
      }
      setExternalSubtitleTracks([]);
      // Subtitles aren't sourced from this response for the HLS path — Jellyfin embeds them as
      // switchable HLS renditions, discovered below via hls.js / textTracks once the manifest
      // actually loads (a different index scheme than the one above).
      setSubtitleTracks([]);
      setCurrentSubtitleId(null);

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
        video.textTracks.addEventListener("addtrack", () => readNativeSubtitles(video));
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
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        setSubtitleTracks(
          hls.subtitleTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Piste ${i + 1}` }))
        );
        setCurrentSubtitleId(hls.subtitleTrack >= 0 ? hls.subtitleTrack : null);
      });
      hls.on(Hls.Events.ERROR, (_evt, data2) => {
        if (data2.fatal) setError("La lecture a été interrompue.");
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

  const changeSubtitle = useCallback((id: number | null) => {
    const video = videoRef.current;
    if (!video) return;
    if (hlsRef.current) {
      hlsRef.current.subtitleTrack = id ?? -1;
    } else {
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = i === id ? "showing" : "disabled";
      }
    }
    setCurrentSubtitleId(id);
  }, []);

  // Kicks off async playback setup (fetch + hls.js wiring) on mount — real effect work, not a
  // simple state derivation, so it can't move to render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    startPlayback({ resumeAt: initialResumeAt });
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
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
      ) : error ? (
        <p className="flex h-full items-center justify-center px-6 text-center text-sm text-red-400">{error}</p>
      ) : (
        <video
          ref={videoRef}
          playsInline
          autoPlay
          className={isMini ? "h-full w-full object-cover" : "h-full w-full"}
          {...{ "x-webkit-airplay": "allow" }}
        >
          {isDirectPlay &&
            externalSubtitleTracks.map((t) => (
              <track key={t.index} kind="subtitles" src={t.url} srcLang={t.language} label={t.label} />
            ))}
        </video>
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

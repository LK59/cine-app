"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { PlayerControls, type Track } from "@/components/PlayerControls";

interface PlayerModalProps {
  itemId: string;
  title: string;
  onClose: () => void;
  /** Resume position in seconds, if reopening a partially-watched item. */
  resumeAt?: number;
  /** Next episode in the series, if known — enables the credits-time "next up" prompt. */
  nextEpisode?: { itemId: string; title: string } | null;
  /** Swaps to the next episode in place (no close/reopen transition). */
  onAdvance?: (next: { itemId: string; title: string }) => void;
}

// Rough client viewport → max transcode bitrate mapping, sent once at playback
// start so Jellyfin doesn't burn GPU time encoding 4K for a 1080p viewport.
// No mid-playback renegotiation for resolution (accepted tradeoff — see plan).
function pickMaxBitrate(): number {
  const w = window.innerWidth * (window.devicePixelRatio || 1);
  if (w <= 1280) return 4_000_000;
  if (w <= 1920) return 8_000_000;
  return 15_000_000;
}

export function PlayerModal({
  itemId,
  title,
  onClose,
  resumeAt: initialResumeAt,
  nextEpisode,
  onAdvance,
}: PlayerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [session, setSession] = useState<{
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

  const stopPlaybackNow = usePlaybackSession(videoRef, session);

  // Swaps to the next episode in place — reports the current one's final
  // position first, same as a manual close, but never triggers the
  // close/unmount fade since the modal stays open for the new episode.
  const handleAdvance = useCallback(() => {
    if (!nextEpisode || !onAdvance) return;
    stopPlaybackNow();
    onAdvance(nextEpisode);
  }, [nextEpisode, onAdvance, stopPlaybackNow]);

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
    setTimeout(onClose, CLOSE_MS);
  }, [onClose, stopPlaybackNow]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

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

      const res = await fetch("/api/jellyfin/playback/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          maxBitrate: pickMaxBitrate(),
          audioStreamIndex: opts?.audioStreamIndex,
          startTicks: opts?.resumeAt ? Math.floor(opts.resumeAt * 10_000_000) : undefined,
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

      setSession({ itemId, playSessionId: data.playSessionId, mediaSourceId: data.mediaSourceId });
      setAudioTracks(
        (data.audioTracks ?? []).map((t: { index: number; label: string }) => ({
          id: t.index,
          label: t.label,
        }))
      );
      setCurrentAudioId(opts?.audioStreamIndex ?? data.audioTracks?.find((t: { isDefault: boolean }) => t.isDefault)?.index ?? null);
      // Subtitles aren't sourced from this response — Jellyfin embeds them as
      // switchable HLS renditions, discovered below via hls.js / textTracks
      // once the manifest actually loads.
      setSubtitleTracks([]);
      setCurrentSubtitleId(null);
      setIntroSkip(data.introSkip ?? null);
      setCreditsStart(data.creditsStart ?? null);

      const resumeAt = opts?.resumeAt;
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (resumeAt) video.currentTime = resumeAt;
          setLoading(false);
        },
        { once: true }
      );

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemId]
  );

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

  useEffect(() => {
    startPlayback({ resumeAt: initialResumeAt });
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPlayback]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={containerRef}
      className={`fixed inset-0 z-80 flex items-center justify-center bg-black transition-opacity duration-200 ${
        closing ? "opacity-0" : "opacity-100 animate-fade-in"
      }`}
    >
      {needsReauth ? (
        <div className="max-w-xs px-6 text-center">
          <p className="mb-4 text-sm text-white">Ta session Jellyfin a expiré.</p>
          <a
            href={`/login?reason=playback&next=${encodeURIComponent(window.location.pathname)}`}
            className="btn-primary inline-flex justify-center"
          >
            Se reconnecter
          </a>
        </div>
      ) : error ? (
        <p className="px-6 text-center text-sm text-red-400">{error}</p>
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video ref={videoRef} playsInline autoPlay className="h-full w-full" {...{ "x-webkit-airplay": "allow" }} />
      )}
      <PlayerControls
        videoRef={videoRef}
        containerRef={containerRef}
        title={title}
        onClose={handleClose}
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
        nextEpisode={nextEpisode ?? null}
        onAdvance={handleAdvance}
      />
    </div>,
    document.body
  );
}

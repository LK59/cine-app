"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal, flushSync } from "react-dom";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { PlayerControls, type Track, VOLUME_STORAGE_KEY } from "@/components/PlayerControls";
import { MiniPlayerChrome, useMiniPlayerDrag } from "@/components/MiniPlayer";
import { useViewportResizing } from "@/lib/useViewportResizing";
import { useExperimentalPlayer } from "@/lib/useExperimentalPlayer";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";
import { PlaybackInfoPanel } from "@/components/PlaybackInfoPanel";
import { usePlayback, PLAYER_RELOAD_INTENT_KEY } from "@/components/PlaybackProvider";
import { detectCodecSupport } from "@/lib/codecSupport";
import { useT } from "@/components/TranslationProvider";

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

// ── Audio-codec fallback ladder (native HLS path) ────────────────────────────────────────────
// Ground truth from live testing: a device's own canPlayType() can overreport what its native
// HLS pipeline really accepts — the concrete case being an iPhone whose canPlayType claims
// E-AC-3 support while its HLS master-playlist variant filter rejects any CODECS="…,ec-3"
// stream outright (MediaError 4, instantly, with byte-identical playlists to a working AC-3
// negotiation — every other explanation was tested and eliminated one by one). Since claimed
// support can't be trusted, actual playback is the only reliable probe: on a fatal native
// error, retry the same request with a progressively reduced audio codec set, which makes
// Jellyfin fall back to a genuine server-side audio transcode. The final rung (AAC only) is
// always transcodable and universally decodable, so the ladder can't strand the user.
// A codec disabled on the rung that finally SUCCEEDS is persisted per-browser (localStorage)
// so every future load on this device excludes it up front — one failed attempt total, ever,
// instead of a failure dance on every playback.
const AUDIO_FALLBACK_RUNGS: string[][] = [
  [], // replay the identical request first — absorbs transient teardown races, learns nothing
  ["eac3", "flac", "opus"], // keep aac+ac3, the two most reliably decoded codecs on Apple hw
  ["eac3", "flac", "opus", "ac3"], // AAC only — forces a clean server transcode, always works
];

const AUDIO_BLOCKLIST_KEY = "cine:audio-codec-blocklist:v1";

function readAudioBlocklist(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AUDIO_BLOCKLIST_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function persistAudioBlocklist(codecs: string[]): void {
  try {
    localStorage.setItem(AUDIO_BLOCKLIST_KEY, JSON.stringify([...new Set(codecs)]));
  } catch {
    // Storage unavailable — the ladder just re-learns next session.
  }
}
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
  const experimental = useExperimentalPlayer();
  // Set by the experimental player's own "switch to the stable player" button. Deliberately not
  // persisted: it applies to this session only, so the option in settings stays the source of
  // truth and the next playback tries the experimental path again — which is what makes it
  // useful for finding out which files it actually cannot handle.
  const [fallbackItemIds, setFallbackItemIds] = useState<string[]>([]);

  if (!session) return null;

  const useExperimental = experimental.enabled && !fallbackItemIds.includes(session.itemId);
  if (useExperimental) {
    return (
      <ExperimentalPlayerHost
        session={session}
        mode={mode === "mini" ? "mini" : "full"}
        onFallback={() => setFallbackItemIds((ids) => [...ids, session.itemId])}
      />
    );
  }

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
  const t = useT();
  const { itemId, title, resumeAt: initialResumeAt, initialAudioStreamIndex, fromReload, reloadAttempt } = session;

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
  // Belt-and-braces for the native (non-hls.js) path: iOS's media daemon releases HLS sessions
  // asynchronously, so even with the reload-based track switch a fresh load can race the old
  // session's teardown and get refused (SRC_NOT_SUPPORTED). One automatic, delayed re-attempt
  // absorbs that race invisibly; only a second consecutive failure surfaces the error UI.
  // Reset on every successful load ('loadeddata'), NOT at the top of startPlayback — the retry
  // itself goes through startPlayback, which would otherwise clear its own budget.
  const nativeErrorRetryCount = useRef(0);
  const nativeErrorRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The opts of the most recent startPlayback call, so an automatic retry replays the SAME
  // request (audio track included) — state like currentAudioId would be stale inside the
  // error listener's closure.
  const lastPlaybackOpts = useRef<{ audioStreamIndex?: number; resumeAt?: number; disableAudioCodecs?: string[] } | undefined>(undefined);
  // Re-tested in isolation now that the Range/206 and manifest-prewarm bugs are both confirmed
  // fixed — a previous attempt at this (ebc2d2d) was reverted after appearing not to help, but
  // that test ran while the Range-truncation bug was still live, which may have masked whether
  // this was actually necessary. Bumped to force a genuinely fresh <video> element (via the
  // `key` prop below) for a track switch on WebKit, instead of reusing the same node.
  const [videoKey, setVideoKey] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [loading, setLoading] = useState(true);
  // True only while hls.js is mid-retry after a fatal network/media error — distinct from
  // `loading` (the initial "fetching a fresh manifest" spinner) and from `error` (retries
  // exhausted, playback truly stopped). Drives the small non-blocking "Reconnexion..." banner.
  const [reconnecting, setReconnecting] = useState(false);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  // Non-interactive — a measured signal, not a settings toggle. Two real, checkable metrics
  // (not an invented "latency" a browser can't actually observe for HLS segments): how often
  // playback has stalled to rebuffer in the last minute, and the decoder's own RECENT
  // dropped-frame rate via the standard getVideoPlaybackQuality() API. Reset per session in
  // startPlayback.
  const [badConnection, setBadConnection] = useState(false);
  const rebufferTimestamps = useRef<number[]>([]);
  const hasPlayedOnce = useRef(false);
  // A deliberate seek always fires 'waiting' too (the video briefly reloads at the new
  // position) — reported live as a false-positive trigger during normal scrubbing, nothing to
  // do with connection quality. 'waiting' within this long after a 'seeking' event is ignored.
  const lastSeekAt = useRef(0);
  // getVideoPlaybackQuality()'s dropped/total counts are cumulative since playback started, so a
  // ratio computed directly from them can only ever climb — once real congestion pushed it past
  // the threshold once, the badge could never clear again even after the connection fully
  // recovered. Comparing against the previous poll's reading turns it into a recent-window rate
  // that can properly drop back down.
  const lastQuality = useRef<{ total: number; dropped: number } | null>(null);
  // Estimated actual network throughput (hls.js's own adaptive-bitrate estimate) — distinct
  // from playbackInfo.video.bitRate/audio.bitRate, which are the STATIC target bitrate Jellyfin
  // encoded/is streaming at. Only meaningful on the hls.js path (Transcode/DirectStream on
  // Chrome/Firefox); native Safari HLS has no equivalent and this just stays null there.
  const [networkBitrate, setNetworkBitrate] = useState<number | null>(null);
  // True once loading/reconnecting has been ongoing for >3s — drives the "still loading, don't
  // close the player" reassurance line for heavy flows (a 4K track switch can legitimately take
  // 15-20s across the grace delay, codec ladder and reload escalation).
  const [loadingLong, setLoadingLong] = useState(false);
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

  // (Re)starts playback, optionally at a specific audio track / resume point.
  // Jellyfin only ever transcodes ONE audio stream into the HLS output (unlike
  // subtitles, which it exposes as switchable renditions), so changing audio
  // means asking for a brand new transcode. Jellyfin's HLS output here is a
  // full VOD playlist covering the whole runtime regardless of StartTimeTicks
  // (seeking already works by jumping within it) — so instead of trusting
  // Jellyfin to start the new stream at the right offset, we seek the video
  // to resumeAt ourselves once the new manifest's metadata is ready.
  const startPlayback = useCallback(
    async (opts?: { audioStreamIndex?: number; resumeAt?: number; disableAudioCodecs?: string[] }) => {
      let video = videoRef.current;
      if (!video) return;

      // Per-browser learned exclusions (see AUDIO_FALLBACK_RUNGS) merged with this call's own —
      // so a codec this device already proved it can't play is excluded from the very first
      // negotiation, not rediscovered through a failure on every playback.
      const disableAudioCodecs = [...new Set([...readAudioBlocklist(), ...(opts?.disableAudioCodecs ?? [])])];
      lastPlaybackOpts.current = opts;

      // WebKit only — hls.js (Firefox, Chrome/Edge desktop & Android) already handles reusing
      // the element correctly via its own MediaSource and was never affected by this.
      if (video.src && video.canPlayType("application/vnd.apple.mpegurl")) {
        flushSync(() => setVideoKey((k) => k + 1));
        video = videoRef.current;
        if (!video) return;
      }

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
      rebufferTimestamps.current = [];
      hasPlayedOnce.current = false;
      lastSeekAt.current = 0;
      lastQuality.current = null;
      setBadConnection(false);
      setNetworkBitrate(null);

      // (An earlier revision also waited for the "emptied" event here before reassigning src —
      // removed: it was built on a disproven teardown-timing theory and only added up to 300ms
      // of dead latency to every hls.js track switch. WebKit gets a fresh element via the
      // remount above; hls.js manages its own MediaSource and needs nothing.)

      const codecSupport = await detectCodecSupport();

      // Safari and iOS play HLS natively and never touch hls.js; everything else needs it, and
      // it is a 376 KB chunk. Awaiting that download only at its point of use — after
      // /playback/start has already answered — put the whole thing on the critical path to the
      // first frame. Kicking it off HERE overlaps it with the request, the negotiation and
      // ffmpeg's warm-up, which is dead time it can hide behind entirely.
      //
      // The value is awaited far below, on the one branch that needs it; the DirectPlay and
      // native-HLS branches return before then and simply leave it downloading into the browser
      // cache, where the next transcoded title will find it. The extra .catch() is only there so
      // an early return can't leave a rejected promise unhandled — the await below still sees
      // (and throws) the original rejection exactly as it did before.
      const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
      const hlsModule = nativeHls ? null : import("hls.js");
      hlsModule?.catch(() => {});

      const res = await fetch("/api/jellyfin/playback/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          maxBitrate: pickMaxBitrate(),
          audioStreamIndex: opts?.audioStreamIndex,
          startTicks: opts?.resumeAt ? Math.floor(opts.resumeAt * 10_000_000) : undefined,
          codecSupport,
          disableAudioCodecs,
          // Lets the server skip its manifest pre-warm for us — see the route. hls.js retries a
          // slow first manifest patiently; Safari's native pipeline does not, which is who that
          // pre-warm was built for.
          nativeHls,
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
        // Root cause found live via real Jellyfin logs during a reproduced test: setting
        // currentTime this early (previously on 'loadedmetadata', which only guarantees
        // duration/dimensions are known — no data buffered yet at any position) made Safari's
        // native HLS engine jump straight to the resume target's segment before the very first
        // manifest bootstrap (segment 0 + its init segment) had even settled. That collided with
        // Jellyfin's own ffmpeg job for segment 0, which got killed mid-request right as our
        // client's init-segment fetch landed on it — logged server-side as "task was canceled"
        // then "doesn't exist and no transcode is running". hls.js already sequences this more
        // carefully, which is why Firefox never hit it despite running the exact same code here.
        // 'loadeddata' guarantees the browser actually has playable data at the CURRENT position
        // first, so the resume seek only fires once the initial bootstrap has already succeeded.
        "loadeddata",
        () => {
          if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
          loadWatchdog.current = null;
          nativeErrorRetryCount.current = 0;
          // A successful load with codecs disabled beyond what the blocklist already held means
          // the fallback ladder just identified the culprit(s) — persist so every future load on
          // this browser excludes them from the first negotiation (see AUDIO_FALLBACK_RUNGS).
          if (opts?.disableAudioCodecs?.length) {
            persistAudioBlocklist([...readAudioBlocklist(), ...opts.disableAudioCodecs]);
          }
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
        setError(t('player.loadingTooLong'));
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

      // A play() rejected with NotAllowedError is iOS's autoplay policy, not a media failure:
      // the reload-based WebKit track switch lands on a fresh page that has no user activation
      // (the tap that picked the language happened on the PREVIOUS page), so programmatic
      // playback with sound is denied even though the stream itself loaded fine. iOS only
      // exempts MUTED autoplay, which was tried and rejected as UX (silently playing video
      // after an audio-track switch defeats the point) — so the deliberate behavior is a clean
      // paused state: spinner cleared, play button showing, one tap resumes with the new track.
      const playAllowingGesture = () => {
        video.play().catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "NotAllowedError") {
            setLoading(false);
          }
        });
      };

      // DirectPlay/DirectStream: a plain Range-seekable file, not an HLS manifest — no hls.js,
      // no native-HLS branch below, just a regular <video src>.
      if (data.isDirectPlay) {
        video.src = data.manifestUrl;
        video.load();
        playAllowingGesture();
        return;
      }

      // Safari (desktop + iOS) plays HLS natively — hls.js is only needed where
      // that's absent (Chrome/Firefox).
      if (nativeHls) {
        video.src = data.manifestUrl;
        // Reassigning .src alone doesn't reliably tear down Safari's existing
        // HLS session when only the query string changes (e.g. switching
        // audio track) — force a clean reload so it actually picks up the
        // new manifest instead of silently continuing the old one.
        video.load();
        playAllowingGesture();
        return;
      }

      // Started alongside the request above, not here — see its comment. Non-null because this
      // branch is only reached when canPlayType said there is no native HLS.
      const { default: Hls } = await hlsModule!;
      if (!Hls.isSupported()) {
        setError(t('player.unsupportedBrowser'));
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
        // hls.js keeps refining this per fragment even with a single-rendition stream (no real
        // ABR ladder from Jellyfin's transcoder) — piggybacking on the same event that already
        // resets the retry counters avoids adding a separate polling interval just for this.
        if (typeof hls.bandwidthEstimate === "number" && hls.bandwidthEstimate > 0) {
          setNetworkBitrate(Math.round(hls.bandwidthEstimate));
        }
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
              setError(t('player.playbackInterruptedCheckConnection'));
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
              setError(t('player.playbackInterrupted'));
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
            setError(t('player.playbackInterrupted'));
        }
      });
      hls.loadSource(data.manifestUrl);
      hls.attachMedia(video);
    },
    // t (from useT()) only changes on a locale switch mid-playback, an edge case not worth
    // recreating this whole callback for — deps deliberately narrowed to itemId already (see
    // startPlaybackRef's own comment below for why).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemId]
  );

  // Always-fresh reference for the error listener's retry timer — that effect's deps are
  // deliberately frozen (it re-binds only on element remount), so calling startPlayback through
  // its closure directly would replay a stale itemId after an episode advance.
  const startPlaybackRef = useRef(startPlayback);
  useEffect(() => {
    startPlaybackRef.current = startPlayback;
  }, [startPlayback]);

  const changeAudio = useCallback(
    (id: number) => {
      const video = videoRef.current;
      const resumeAt = video?.currentTime ?? 0;
      // WebKit only: switching audio in-place reliably fails there with MediaError
      // SRC_NOT_SUPPORTED — a genuine, reproducible WebKit limitation on loading a second HLS
      // session within the same page. Verified this isn't about DOM element reuse (fails
      // identically with a freshly created <video> element), our own HTTP/manifest handling
      // (verified byte-correct both directly against Jellyfin and through our own proxy), or
      // ffmpeg startup timing (fails just as fast for a plain remux as a real transcode) — every
      // other angle has been tested and ruled out. A full page reload sidesteps it entirely: the
      // new track then loads as the page's first-ever HLS session, which has never once failed
      // across every test. Persists just enough to resume exactly where playback left off.
      if (video?.canPlayType("application/vnd.apple.mpegurl")) {
        try {
          sessionStorage.setItem(
            PLAYER_RELOAD_INTENT_KEY,
            JSON.stringify({ itemId, title, audioStreamIndex: id, resumeAt })
          );
        } catch {
          // Storage unavailable (private browsing, quota) — falls through to the in-place
          // switch below, which will still surface the usual error+retry UI if it fails.
        }
        // Tear the current media session down BEFORE reloading, not merely as a side effect of
        // the page dying: iOS's media daemon (mediaserverd) releases HLS sessions asynchronously
        // and independently of the page lifecycle, so a reload issued while the old stream is
        // still actively playing can bring the new page up before the old session is gone.
        // Starting teardown explicitly here buys that release as much head start as possible.
        video.pause();
        video.removeAttribute("src");
        video.load();
        window.location.reload();
        return;
      }
      startPlayback({ audioStreamIndex: id, resumeAt });
    },
    [startPlayback, itemId, title]
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
    // Grace period after a reload-based track switch (see PlaybackSession.fromReload): iOS's
    // media daemon releases the previous page's HLS session asynchronously, roughly
    // proportionally to how much it had buffered. Proven live with byte-identical server
    // responses: resuming after a ~3s-old session loaded fine, after an 8-minute session it was
    // refused instantly (SRC_NOT_SUPPORTED) — the only remaining variable was the old session's
    // weight. Waiting here lets that release finish before the new session asks for its slot.
    // Remembered volume — applied once here, right when the session starts, rather than in
    // PlayerControls (which remounts on every full<->mini toggle and would otherwise re-apply
    // it on top of whatever the video's actual live volume already is).
    try {
      const stored = localStorage.getItem(VOLUME_STORAGE_KEY);
      if (stored && videoRef.current) {
        const { volume, muted } = JSON.parse(stored) as { volume: number; muted: boolean };
        if (typeof volume === "number") videoRef.current.volume = volume;
        if (typeof muted === "boolean") videoRef.current.muted = muted;
      }
    } catch {
      // Malformed or unavailable — video just keeps its own default volume.
    }

    const graceMs = fromReload ? 3000 : 0;
    const graceTimer = setTimeout(() => {
      startPlayback({ resumeAt: initialResumeAt, audioStreamIndex: initialAudioStreamIndex });
    }, graceMs);
    return () => {
      clearTimeout(graceTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (networkRetryTimer.current) clearTimeout(networkRetryTimer.current);
      networkRetryTimer.current = null;
      if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
      loadWatchdog.current = null;
      if (nativeErrorRetryTimer.current) clearTimeout(nativeErrorRetryTimer.current);
      nativeErrorRetryTimer.current = null;
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
  }, [handleClose, videoKey]);

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
  }, [videoKey]);

  // Drives the ">3s, still working on it" reassurance line — heavy 4K track switches can
  // legitimately spend 15-20s across the post-reload grace delay, codec fallback ladder and
  // reload escalation, and a bare spinner that long reads as a hang worth force-closing.
  useEffect(() => {
    if (!loading && !reconnecting) {
      // Deferred (timeout 0) rather than set synchronously in the effect body — same outcome,
      // without the render-cascade pattern the react-hooks/set-state-in-effect rule flags.
      const clear = setTimeout(() => setLoadingLong(false), 0);
      return () => clearTimeout(clear);
    }
    const t = setTimeout(() => setLoadingLong(true), 3000);
    return () => clearTimeout(t);
  }, [loading, reconnecting]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      lastKnownTime.current = video.currentTime;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoKey]);

  // Bad-connection badge: a real stall mid-playback ('waiting' firing after the video has
  // already played at least once — excludes ordinary startup buffering) is logged with a
  // timestamp; a periodic check then looks at how many landed in the last 60s, combined with
  // the decoder's own dropped-frame ratio, to decide whether to show the badge. Both are actual
  // measured signals, not a guess — see badConnection's own comment for why not a fabricated
  // "latency" number.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlaying = () => {
      hasPlayedOnce.current = true;
    };
    const onSeeking = () => {
      lastSeekAt.current = Date.now();
    };
    const onWaiting = () => {
      if (hasPlayedOnce.current && Date.now() - lastSeekAt.current > 2000) rebufferTimestamps.current.push(Date.now());
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("waiting", onWaiting);

    const interval = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      rebufferTimestamps.current = rebufferTimestamps.current.filter((t) => t > cutoff);
      const quality = video.getVideoPlaybackQuality?.();
      let droppedRatio = 0;
      if (quality) {
        const prev = lastQuality.current;
        const deltaTotal = prev ? quality.totalVideoFrames - prev.total : 0;
        const deltaDropped = prev ? quality.droppedVideoFrames - prev.dropped : 0;
        if (deltaTotal > 0) droppedRatio = deltaDropped / deltaTotal;
        lastQuality.current = { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
      }
      setBadConnection(rebufferTimestamps.current.length >= 2 || droppedRatio > 0.02);
    }, 5000);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("waiting", onWaiting);
      clearInterval(interval);
    };
  }, [videoKey]);

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
      const code = video!.error?.code;
      if (code === MediaError.MEDIA_ERR_ABORTED) return;
      // Walks AUDIO_FALLBACK_RUNGS (see its comment for the why): rung 0 replays the identical
      // request (absorbs transient teardown races and learns nothing), each further rung
      // disables more audio codecs until the AAC-only rung guarantees a clean server-side audio
      // transcode. The rung whose exclusions finally make the load succeed gets persisted by the
      // 'loadeddata' handler, so future loads on this browser skip the failure dance entirely.
      if (nativeErrorRetryCount.current < AUDIO_FALLBACK_RUNGS.length) {
        const rung = AUDIO_FALLBACK_RUNGS[nativeErrorRetryCount.current];
        nativeErrorRetryCount.current += 1;
        const delay = 1200 * nativeErrorRetryCount.current;
        setReconnecting(true);
        if (nativeErrorRetryTimer.current) clearTimeout(nativeErrorRetryTimer.current);
        nativeErrorRetryTimer.current = setTimeout(() => {
          startPlaybackRef.current({
            ...lastPlaybackOpts.current,
            resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt,
            disableAudioCodecs: [...new Set([...(lastPlaybackOpts.current?.disableAudioCodecs ?? []), ...rung])],
          });
        }, delay);
        return;
      }
      // Ladder exhausted. On WebKit, one final escalation before giving up: a fresh full page
      // reload — the only teardown that reliably releases every media-daemon session this page
      // has accumulated, including the zombie attempts each failed retry above just created —
      // whose grace-delayed restart (see fromReload) then loads into a genuinely clean slate.
      // Strictly bounded by the attempt counter carried in the intent so two exhausted ladders
      // can never reload-loop forever.
      if ((reloadAttempt ?? 0) < 1 && video!.canPlayType("application/vnd.apple.mpegurl")) {
        try {
          const audioIdx = lastPlaybackOpts.current?.audioStreamIndex;
          sessionStorage.setItem(
            PLAYER_RELOAD_INTENT_KEY,
            JSON.stringify({
              itemId,
              title,
              resumeAt: lastKnownTime.current || lastPlaybackOpts.current?.resumeAt || 0,
              attempt: (reloadAttempt ?? 0) + 1,
              ...(audioIdx !== undefined ? { audioStreamIndex: audioIdx } : {}),
            })
          );
          video!.pause();
          video!.removeAttribute("src");
          video!.load();
          window.location.reload();
          return;
        } catch {
          // Storage unavailable — fall through to the error UI below.
        }
      }
      setReconnecting(false);
      setLoading(false);
      setError(t('player.playbackInterrupted'));
    }
    video.addEventListener("error", onError);
    return () => video.removeEventListener("error", onError);
    // t (from useT()) only changes on a locale switch mid-playback, not worth re-binding this
    // listener for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey, itemId, title, reloadAttempt]);

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
  // A rotation resizes the player; it should not *animate* that resize (see the hook).
  const resizing = useViewportResizing();

  // Tab order follows DOM order, not visual stacking — without this, keyboard focus is left
  // wherever it was on the page that opened playback (e.g. Cinema Mode's "Lecture" row, which
  // stays mounted underneath at a lower z-index) instead of moving into the now-visible player,
  // so Tab/Enter appear to do nothing. One frame after mounting full-screen, land specifically on
  // play/pause (data-player-nav="playpause", not just "the first button" — the skip/rewind
  // buttons sitting either side of it in DOM order made that unpredictable) so keyboard control
  // starts on the one control every remote/keyboard user reaches for first.
  // A single requestAnimationFrame here isn't enough: PlayerControls only renders the
  // play/pause button once `!loading && !buffering` (a spinner shows until then), and mode
  // flips to "full" the instant playback.play() is called — long before the stream has actually
  // loaded. That one-shot attempt was landing on nothing, silently, so focus just stayed
  // wherever it was (a Cinema Mode menu row, hidden behind the player) — which then made
  // PlayerControls' own "don't steal Space from a focused button" guard swallow Space too,
  // since SOME button still technically had focus, just the wrong one. Poll instead, until the
  // button actually exists (or mode changes away from full).
  useEffect(() => {
    if (mode !== "full") return;
    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      const btn = containerRef.current?.querySelector<HTMLButtonElement>('[data-player-nav="playpause"]');
      if (btn) {
        btn.focus();
        clearInterval(id);
      } else if (attempts > 40) {
        // ~10s cap — a fatal load error keeps `loading` true forever with no button to ever
        // find, so this has to give up eventually rather than poll indefinitely.
        clearInterval(id);
      }
    }, 250);
    return () => clearInterval(id);
  }, [mode]);

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
        transition: isDragging || resizing ? "none" : TRANSITION,
        touchAction: "none",
      }
    : {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        borderRadius: 0,
        zIndex: 80,
        background: "black",
        transition: resizing ? "opacity 200ms ease-out" : `${TRANSITION}, opacity 200ms ease-out`,
        opacity: closing ? 0 : 1,
      };

  return createPortal(
    <div
      ref={containerRef}
      style={style}
      // app-viewport rather than an inline 100dvh — see its note in globals.css: the right unit
      // for a full-screen shell differs between a browser tab and an installed PWA.
      className={isMini ? "animate-fade-in-scale" : "app-viewport"}
      {...(isMini ? handlers : {})}
    >
      {needsReauth ? (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div>
            <p className="mb-4 text-sm text-white">{t('player.sessionExpired')}</p>
            <a
              href={`/login?reason=playback&next=${encodeURIComponent(window.location.pathname)}`}
              className="btn-primary inline-flex justify-center"
            >
              {t('player.reconnect')}
            </a>
          </div>
        </div>
      ) : (
        <>
          {/* Kept mounted even while `error` is showing, so `lastKnownTime`/hls state aren't
              lost and "Réessayer" can resume from where playback actually stopped, instead of
              from the beginning. `key` changes (WebKit track switches only) intentionally force
              a full remount — see videoKey's own comment above. */}
          <video
            key={videoKey}
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
                    {t('player.quit')}
                  </button>
                  <button type="button" onClick={handleRetry} className="btn-primary inline-flex justify-center">
                    {t('common.retry')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {!error && !isMini && (isOffline || reconnecting || (loading && loadingLong)) && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-[max(1rem,env(safe-area-inset-bottom))]">
              <div className="rounded-full bg-black/80 px-4 py-1.5 text-center text-xs text-white shadow-lg ring-1 ring-white/10">
                {isOffline
                  ? t('player.offline')
                  : loadingLong
                    ? t('player.stillLoading')
                    : t('player.reconnecting')}
              </div>
            </div>
          )}
          {/* Non-interactive by design — a measured signal (recent rebuffers + decoder dropped-
              frame ratio, see badConnection's own comment), not a settings toggle with a detail
              view to open. Top-right so it never overlaps the bottom pill above, which the two
              can legitimately show at the same time (e.g. offline AND already mid-rebuffer). */}
          {!error && !isMini && badConnection && (
            <div
              className="pointer-events-none absolute z-20 rounded-full bg-black/80 px-3 py-1 text-xs text-amber-300 shadow-lg ring-1 ring-white/10"
              style={{ top: "max(4.5rem, calc(env(safe-area-inset-top) + 6rem))", right: "max(1rem, env(safe-area-inset-right))" }}
            >
              {t("player.badConnection")}
            </div>
          )}
        </>
      )}
      {!isMini && (
        <PlayerControls
          key={videoKey}
          videoRef={videoRef}
          containerRef={containerRef}
          itemId={itemId}
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
        <PlaybackInfoPanel
          info={playbackInfo}
          networkBitrate={networkBitrate}
          open={showPlaybackInfo}
          onClose={() => setShowPlaybackInfo(false)}
        />
      )}
      {isMini && !error && !needsReauth && (
        <MiniPlayerChrome title={title} playing={playing} onTogglePlay={toggleMiniPlay} onClose={handleClose} />
      )}
    </div>,
    document.body
  );
}

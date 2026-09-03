"use client";

import { X } from "lucide-react";
import type { PlaybackInfoSummary } from "@/components/PlayerHost";
import { useT } from "@/components/TranslationProvider";

interface Props {
  info: PlaybackInfoSummary | null;
  networkBitrate: number | null;
  open: boolean;
  onClose: () => void;
  /**
   * Why the experimental player handed this file over, when it did.
   *
   * The viewer is no longer asked to decide, and is told only "negotiating with the server" for
   * a few seconds. This is where the actual reason stays reachable — a step down that leaves no
   * account of itself is how a player that stopped using its best path goes unnoticed for months.
   */
  fallbackReason?: string | null;
}

// Every one of these is a real Jellyfin TranscodeReason string — translated via
// player.info.reasons.<key> when known; an unrecognized one (a Jellyfin version returning a
// reason this app doesn't know about yet) falls back to the raw string rather than a raw i18n
// key path, same as the old REASON_LABELS[r] ?? r behavior.
const KNOWN_REASONS = new Set([
  "ContainerNotSupported", "VideoCodecNotSupported", "AudioCodecNotSupported",
  "SubtitleCodecNotSupported", "VideoProfileNotSupported", "VideoLevelNotSupported",
  "VideoResolutionNotSupported", "VideoBitDepthNotSupported", "VideoFramerateNotSupported",
  "VideoRangeTypeNotSupported", "AudioChannelsNotSupported", "AudioProfileNotSupported",
  "AnamorphicVideoNotSupported", "InterlacedVideoNotSupported", "RefFramesNotSupported",
  "ContainerBitrateExceedsLimit", "VideoBitrateNotSupported", "AudioBitrateNotSupported",
  "DirectPlayError",
]);

const METHOD_COLOR: Record<PlaybackInfoSummary["playMethod"], string> = {
  DirectPlay: "text-emerald-400",
  DirectStream: "text-sky-400",
  Transcode: "text-amber-400",
};

function formatBitrate(bitRate: number | null): string | null {
  if (!bitRate) return null;
  return `${(bitRate / 1_000_000).toFixed(1)} Mb/s`;
}

export function PlaybackInfoPanel({ info, networkBitrate, open, onClose, fallbackReason }: Props) {
  const t = useT();
  if (!open || !info) return null;

  const methodLabel =
    info.playMethod === "DirectPlay" ? t('player.info.directPlay')
    : info.playMethod === "DirectStream" ? t('player.info.directStream')
    : t('player.info.transcode');

  const methodDescription = (() => {
    if (info.playMethod === "DirectPlay") return t('player.info.describeDirectPlay');
    if (info.playMethod === "DirectStream") {
      const audioOnly = info.transcodeReasons.some((r) => r.startsWith("Audio"));
      return audioOnly ? t('player.info.describeDirectStreamAudio') : t('player.info.describeDirectStreamContainer');
    }
    return t('player.info.describeTranscode');
  })();

  return (
    <div
      // z-20: above PlayerControls' full-screen click-catching overlay (z-10, transparent,
      // captures pointer events to auto-hide/show controls) — without this the panel paints
      // visually on top but pointer events (close button, scroll) never actually reach it.
      className="pointer-events-auto absolute z-20 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl bg-slate-900/95 shadow-2xl ring-1 ring-white/10"
      style={{
        top: "max(4rem, calc(env(safe-area-inset-top) + 5rem))",
        left: "max(1rem, env(safe-area-inset-left))",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <p className="text-sm font-medium text-white">{t('player.info.title')}</p>
        <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white">
          <X size={16} />
        </button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-4 text-xs">
        <div className="mb-3">
          <p className={`text-sm font-semibold ${METHOD_COLOR[info.playMethod]}`}>{methodLabel}</p>
          <p className="mt-0.5 text-slate-400">{methodDescription}</p>
        </div>

        {networkBitrate != null && (
          <div className="mb-3">
            <p className="mb-1 font-medium text-slate-300">{t('player.info.network')}</p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-slate-400">
              <dt className="text-slate-500">{t('player.info.estimatedBitrate')}</dt>
              <dd>{formatBitrate(networkBitrate) ?? "—"}</dd>
            </dl>
          </div>
        )}

        {info.transcodeReasons.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 font-medium text-slate-300">{t('player.info.reason')}</p>
            <ul className="space-y-0.5 text-slate-400">
              {info.transcodeReasons.map((r) => (
                <li key={r}>· {KNOWN_REASONS.has(r) ? t(`player.info.reasons.${r}`) : r}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mb-3">
          <p className="mb-1 font-medium text-slate-300">{t('player.info.container')}</p>
          <p className="text-slate-400">{info.container ?? "—"}</p>
        </div>

        {info.video && (
          <div className="mb-3">
            <p className="mb-1 font-medium text-slate-300">{t('player.info.video')}</p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-slate-400">
              <dt className="text-slate-500">{t('player.info.codec')}</dt>
              <dd>{info.video.codec ?? "—"}{info.video.profile ? ` (${info.video.profile})` : ""}</dd>
              <dt className="text-slate-500">{t('player.info.resolution')}</dt>
              <dd>{info.video.width && info.video.height ? `${info.video.width}×${info.video.height}` : "—"}</dd>
              <dt className="text-slate-500">{t('player.info.depth')}</dt>
              <dd>{info.video.bitDepth ? `${info.video.bitDepth} bits` : "—"}</dd>
              <dt className="text-slate-500">{t('player.info.fps')}</dt>
              <dd>{info.video.frameRate ? info.video.frameRate.toFixed(2) : "—"}</dd>
              <dt className="text-slate-500">{t('player.info.bitrate')}</dt>
              <dd>{formatBitrate(info.video.bitRate) ?? "—"}</dd>
            </dl>
          </div>
        )}

        {info.audio && (
          <div>
            <p className="mb-1 font-medium text-slate-300">{t('player.info.audio')}</p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-slate-400">
              <dt className="text-slate-500">{t('player.info.codec')}</dt>
              <dd>{info.audio.codec ?? "—"}</dd>
              <dt className="text-slate-500">{t('player.info.channels')}</dt>
              <dd>{info.audio.channels ?? "—"}</dd>
              <dt className="text-slate-500">{t('player.info.bitrate')}</dt>
              <dd>{formatBitrate(info.audio.bitRate) ?? "—"}</dd>
              <dt className="text-slate-500">{t('player.info.language')}</dt>
              <dd>{info.audio.language ?? "—"}</dd>
            </dl>
          </div>
        )}

        {/* Kept where someone can find it later, because nobody was asked at the time. */}
        {fallbackReason && (
          <div className="border-t border-white/5 pt-3">
            <p className="mb-1 font-medium text-slate-300">Lecteur expérimental</p>
            <p className="leading-5 text-slate-400">A cédé la main : {fallbackReason}</p>
          </div>
        )}
      </div>
    </div>
  );
}

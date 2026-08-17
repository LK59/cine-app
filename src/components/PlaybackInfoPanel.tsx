"use client";

import { X } from "lucide-react";
import type { PlaybackInfoSummary } from "@/components/PlayerHost";

interface Props {
  info: PlaybackInfoSummary | null;
  networkBitrate: number | null;
  open: boolean;
  onClose: () => void;
}

const REASON_LABELS: Record<string, string> = {
  ContainerNotSupported: "Conteneur non supporté",
  VideoCodecNotSupported: "Codec vidéo non supporté",
  AudioCodecNotSupported: "Codec audio non supporté",
  SubtitleCodecNotSupported: "Codec de sous-titres non supporté",
  VideoProfileNotSupported: "Profil vidéo non supporté",
  VideoLevelNotSupported: "Niveau vidéo non supporté",
  VideoResolutionNotSupported: "Résolution non supportée",
  VideoBitDepthNotSupported: "Profondeur de couleur non supportée",
  VideoFramerateNotSupported: "Fréquence d'images non supportée",
  VideoRangeTypeNotSupported: "Plage dynamique (HDR) non supportée",
  AudioChannelsNotSupported: "Nombre de canaux audio non supporté",
  AudioProfileNotSupported: "Profil audio non supporté",
  AnamorphicVideoNotSupported: "Vidéo anamorphique non supportée",
  InterlacedVideoNotSupported: "Vidéo entrelacée non supportée",
  RefFramesNotSupported: "Nombre d'images de référence non supporté",
  ContainerBitrateExceedsLimit: "Débit du conteneur trop élevé",
  VideoBitrateNotSupported: "Débit vidéo non supporté",
  AudioBitrateNotSupported: "Débit audio non supporté",
  DirectPlayError: "Erreur de lecture directe",
};

const METHOD_LABELS: Record<PlaybackInfoSummary["playMethod"], { label: string; color: string }> = {
  DirectPlay: { label: "Lecture directe", color: "text-emerald-400" },
  DirectStream: { label: "Remultiplexage", color: "text-sky-400" },
  Transcode: { label: "Transcodage", color: "text-amber-400" },
};

function describeMethod(info: PlaybackInfoSummary): string {
  if (info.playMethod === "DirectPlay") return "Le fichier est envoyé tel quel, aucune conversion.";
  if (info.playMethod === "DirectStream") {
    const audioOnly = info.transcodeReasons.some((r) => r.startsWith("Audio"));
    return audioOnly
      ? "Vidéo copiée telle quelle, seul l'audio est réencodé."
      : "Vidéo copiée telle quelle, conteneur reconverti à la volée.";
  }
  return "La vidéo est réencodée par le serveur.";
}

function formatBitrate(bitRate: number | null): string | null {
  if (!bitRate) return null;
  return `${(bitRate / 1_000_000).toFixed(1)} Mb/s`;
}

export function PlaybackInfoPanel({ info, networkBitrate, open, onClose }: Props) {
  if (!open || !info) return null;
  const method = METHOD_LABELS[info.playMethod];

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
        <p className="text-sm font-medium text-white">Playback Info</p>
        <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white">
          <X size={16} />
        </button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-4 text-xs">
        <div className="mb-3">
          <p className={`text-sm font-semibold ${method.color}`}>{method.label}</p>
          <p className="mt-0.5 text-slate-400">{describeMethod(info)}</p>
        </div>

        {networkBitrate != null && (
          <div className="mb-3">
            <p className="mb-1 font-medium text-slate-300">Réseau</p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-slate-400">
              <dt className="text-slate-500">Débit estimé</dt>
              <dd>{formatBitrate(networkBitrate) ?? "—"}</dd>
            </dl>
          </div>
        )}

        {info.transcodeReasons.length > 0 && (
          <div className="mb-3">
            <p className="mb-1 font-medium text-slate-300">Raison</p>
            <ul className="space-y-0.5 text-slate-400">
              {info.transcodeReasons.map((r) => (
                <li key={r}>· {REASON_LABELS[r] ?? r}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mb-3">
          <p className="mb-1 font-medium text-slate-300">Conteneur</p>
          <p className="text-slate-400">{info.container ?? "—"}</p>
        </div>

        {info.video && (
          <div className="mb-3">
            <p className="mb-1 font-medium text-slate-300">Vidéo</p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-slate-400">
              <dt className="text-slate-500">Codec</dt>
              <dd>{info.video.codec ?? "—"}{info.video.profile ? ` (${info.video.profile})` : ""}</dd>
              <dt className="text-slate-500">Résolution</dt>
              <dd>{info.video.width && info.video.height ? `${info.video.width}×${info.video.height}` : "—"}</dd>
              <dt className="text-slate-500">Profondeur</dt>
              <dd>{info.video.bitDepth ? `${info.video.bitDepth} bits` : "—"}</dd>
              <dt className="text-slate-500">Images/s</dt>
              <dd>{info.video.frameRate ? info.video.frameRate.toFixed(2) : "—"}</dd>
              <dt className="text-slate-500">Débit</dt>
              <dd>{formatBitrate(info.video.bitRate) ?? "—"}</dd>
            </dl>
          </div>
        )}

        {info.audio && (
          <div>
            <p className="mb-1 font-medium text-slate-300">Audio</p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-slate-400">
              <dt className="text-slate-500">Codec</dt>
              <dd>{info.audio.codec ?? "—"}</dd>
              <dt className="text-slate-500">Canaux</dt>
              <dd>{info.audio.channels ?? "—"}</dd>
              <dt className="text-slate-500">Débit</dt>
              <dd>{formatBitrate(info.audio.bitRate) ?? "—"}</dd>
              <dt className="text-slate-500">Langue</dt>
              <dd>{info.audio.language ?? "—"}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

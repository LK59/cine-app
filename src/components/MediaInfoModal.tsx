"use client";

import { Modal } from "@/components/Modal";
import type { RadarrMovie } from "@/lib/clients/radarr";

function fmt(bps?: number): string {
  if (!bps) return "—";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mb/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kb/s`;
  return `${bps} b/s`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value || value === "—") return null;
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/5 py-2 last:border-0">
      <span className="shrink-0 text-xs text-slate-500">{label}</span>
      <span className="text-right text-xs font-medium text-slate-200">{value}</span>
    </div>
  );
}

export function MediaInfoModal({
  movie,
  onClose,
}: {
  movie: RadarrMovie;
  onClose: () => void;
}) {
  const f = movie.movieFile;
  const mi = f?.mediaInfo;

  function bytes(n?: number): string {
    if (!n) return "—";
    const u = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
  }

  return (
    <Modal title="Informations techniques" onClose={onClose}>
      {!f ? (
        <p className="text-sm text-slate-400">Aucun fichier disponible.</p>
      ) : (
        <div className="space-y-5">
          <section>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Fichier
            </p>
            <Row label="Chemin" value={f.relativePath} />
            <Row label="Taille" value={bytes(f.size)} />
            <Row label="Qualité" value={f.quality?.quality?.name} />
            <Row label="Container" value={mi?.containerFormat} />
          </section>

          <section>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Vidéo
            </p>
            <Row label="Codec" value={mi?.videoCodec} />
            <Row label="Profil" value={mi?.videoProfile} />
            <Row label="Résolution" value={mi?.resolution} />
            <Row label="FPS" value={mi?.videoFps ? `${mi.videoFps} fps` : undefined} />
            <Row label="Bit depth" value={mi?.videoBitDepth ? `${mi.videoBitDepth} bits` : undefined} />
            <Row label="Bitrate" value={mi?.videoBitrate ? fmt(mi.videoBitrate) : undefined} />
            <Row
              label="HDR"
              value={
                mi?.videoHdr || mi?.videoDynamicRangeType
                  ? mi?.videoDynamicRangeType || "HDR"
                  : undefined
              }
            />
            <Row label="Colorimétrie" value={mi?.videoColourPrimaries} />
            <Row label="Transfert" value={mi?.videoTransferCharacteristics} />
            <Row label="Scan" value={mi?.scanType} />
          </section>

          <section>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Audio
            </p>
            <Row label="Codec" value={mi?.audioCodec} />
            <Row label="Canaux" value={mi?.audioChannels ? `${mi.audioChannels} ch` : undefined} />
            <Row label="Pistes" value={mi?.audioStreamCount ? `${mi.audioStreamCount}` : undefined} />
            <Row label="Bitrate" value={mi?.audioBitrate ? fmt(mi.audioBitrate) : undefined} />
            <Row label="Langues" value={mi?.audioLanguages} />
            <Row label="Formats additionnels" value={mi?.audioAdditionalFeatures} />
          </section>

          {mi?.subtitles && (
            <section>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Sous-titres embarqués
              </p>
              <Row label="Pistes" value={mi.subtitles} />
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

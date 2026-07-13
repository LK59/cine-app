"use client";

import { Modal } from "@/components/Modal";
import type { RadarrMovie } from "@/lib/clients/radarr";
import { useT } from "@/components/TranslationProvider";

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
  const t = useT();
  const f = movie.movieFile;
  const mi = f?.mediaInfo;

  function bytes(n?: number): string {
    if (!n) return "—";
    const u = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
  }

  return (
    <Modal title={t('mediaInfo.title')} onClose={onClose}>
      {!f ? (
        <p className="text-sm text-slate-400">{t('mediaInfo.noFile')}</p>
      ) : (
        <div className="space-y-5">
          <section>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {t('mediaInfo.sectionFile')}
            </p>
            <Row label={t('mediaInfo.path')} value={f.relativePath} />
            <Row label={t('mediaInfo.size')} value={bytes(f.size)} />
            <Row label={t('mediaInfo.quality')} value={f.quality?.quality?.name} />
            <Row label={t('mediaInfo.container')} value={mi?.containerFormat} />
          </section>

          <section>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {t('mediaInfo.sectionVideo')}
            </p>
            <Row label={t('mediaInfo.codec')} value={mi?.videoCodec} />
            <Row label={t('mediaInfo.profile')} value={mi?.videoProfile} />
            <Row label={t('mediaInfo.resolution')} value={mi?.resolution} />
            <Row label={t('mediaInfo.fps')} value={mi?.videoFps ? `${mi.videoFps} fps` : undefined} />
            <Row label={t('mediaInfo.bitDepth')} value={mi?.videoBitDepth ? `${mi.videoBitDepth} bits` : undefined} />
            <Row label={t('mediaInfo.bitrate')} value={mi?.videoBitrate ? fmt(mi.videoBitrate) : undefined} />
            <Row
              label={t('mediaInfo.hdr')}
              value={
                mi?.videoHdr || mi?.videoDynamicRangeType
                  ? mi?.videoDynamicRangeType || "HDR"
                  : undefined
              }
            />
            <Row label={t('mediaInfo.colorimetry')} value={mi?.videoColourPrimaries} />
            <Row label={t('mediaInfo.transfer')} value={mi?.videoTransferCharacteristics} />
            <Row label={t('mediaInfo.scan')} value={mi?.scanType} />
          </section>

          <section>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {t('mediaInfo.sectionAudio')}
            </p>
            <Row label={t('mediaInfo.codec')} value={mi?.audioCodec} />
            <Row label={t('mediaInfo.channels')} value={mi?.audioChannels ? `${mi.audioChannels} ch` : undefined} />
            <Row label={t('mediaInfo.tracks')} value={mi?.audioStreamCount ? `${mi.audioStreamCount}` : undefined} />
            <Row label={t('mediaInfo.bitrate')} value={mi?.audioBitrate ? fmt(mi.audioBitrate) : undefined} />
            <Row label={t('mediaInfo.languages')} value={mi?.audioLanguages} />
            <Row label={t('mediaInfo.additionalFormats')} value={mi?.audioAdditionalFeatures} />
          </section>

          {mi?.subtitles && (
            <section>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {t('mediaInfo.sectionSubtitles')}
              </p>
              <Row label={t('mediaInfo.tracks')} value={mi.subtitles} />
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

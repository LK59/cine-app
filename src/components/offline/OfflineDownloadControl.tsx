"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, Check, Download, Play, RotateCcw, Trash2, X } from "lucide-react";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { useToast } from "@/components/Toast";
import { fetcher } from "@/lib/swr";
import { fetchDirectInfo } from "@/lib/directInfo";
import { formatFileSize } from "@/lib/format";
import { labelAudioTracks } from "@/lib/trackLabel";
import { normaliseLanguage, trackLanguage } from "@/lib/trackPreferences";
import { isWebKitEngine } from "@/lib/webkitEngine";
import { useOfflineDownloadsEnabled } from "@/lib/offline/useOfflineEnabled";
import { deviceStoreSupported } from "@/lib/offline/deviceStore";
import { expectedBytes, type OfflineCodec, type OfflineQuality } from "@/lib/offline/quality";
import {
  initOfflineDownloads,
  removeOfflineDownload,
  startOfflineDownload,
  useOfflineDownloadFor,
  type OfflineDownload,
} from "@/lib/offline/downloads";

/**
 * Le téléchargement hors ligne sur la fiche d'un film (bêta, 19/10/2026) — une seule décision pour
 * les deux fiches (bureau et téléphone), qui ne diffèrent que par la forme du bouton.
 *
 * Toujours une question avant de télécharger (Louis) : la piste son — préchoisie dans la langue du
 * compte — et la qualité — Standard préchoisie —, validées par « Télécharger ». Pendant la préparation
 * et le téléchargement, le bouton dit où on en est et se touche pour annuler ; une fois fini, il
 * devient « Lire le fichier téléchargé ». La suppression se fait dans le gestionnaire.
 */

export function BetaBadge() {
  const t = useT();
  return <span className="rounded-full bg-white/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted">{t("player.downloads.beta")}</span>;
}

/** HEVC si ce navigateur le confie à MediaSource, sinon H.264 — ce que le lecteur hors ligne lira. */
function offlineCodec(): OfflineCodec {
  const hevc = 'video/mp4; codecs="hvc1.1.6.L120.90,mp4a.40.2"';
  const managed = (globalThis as { ManagedMediaSource?: { isTypeSupported(t: string): boolean } }).ManagedMediaSource;
  try {
    if (managed?.isTypeSupported(hevc)) return "hevc";
    if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(hevc)) return "hevc";
  } catch {
    /* sondes absentes : H.264, que tout lit */
  }
  return "h264";
}

const appleTouch = () => typeof navigator !== "undefined" && isWebKitEngine(navigator.userAgent) && navigator.maxTouchPoints > 1;

export interface OfflineTitle {
  itemId: string;
  radarrId: number | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  runtimeMinutes: number | null;
}

interface Props extends OfflineTitle {
  /** `row` : une ligne du menu de la fiche au bureau ; `wide` : un bouton pleine largeur au téléphone. */
  variant: "row" | "wide";
  rowClassName?: string;
  badgeClassName?: string;
  /** L'espacement du bouton pleine largeur dans sa colonne. */
  wideSpacing?: string;
}

export function offlineProgress(d: OfflineDownload): number {
  return d.expectedBytes > 0 ? Math.min(99, Math.floor((d.bytes / d.expectedBytes) * 100)) : 0;
}

export function offlineStatusLabel(d: OfflineDownload, t: ReturnType<typeof useT>): string {
  if (d.state === "done") return t("player.downloads.done");
  if (d.state === "failed") return t("player.downloads.failed");
  if (d.state === "preparing" || d.bytes === 0) return t("player.downloads.preparing");
  return t("player.downloads.downloading", { pct: offlineProgress(d) });
}

export function OfflineDownloadControl(props: Props) {
  const enabled = useOfflineDownloadsEnabled();
  const [supported] = useState(deviceStoreSupported);
  // Rien d'autre n'est monté — ni lecteur, ni magasin — tant que la fonction n'est pas ouverte ici.
  return enabled && supported ? <OfflineDownloadControlOn {...props} /> : null;
}

function OfflineDownloadControlOn({ variant, rowClassName = "", badgeClassName = "", wideSpacing = "mb-2", ...title }: Props) {
  const t = useT();
  const download = useOfflineDownloadFor(title.itemId);
  const playback = usePlayback();
  const [choosing, setChoosing] = useState(false);
  const [managing, setManaging] = useState(false);

  useEffect(() => {
    void initOfflineDownloads();
  }, []);

  const playDownloaded = (d: OfflineDownload) =>
    playback.play({ itemId: d.itemId, title: d.title, resumeAt: d.positionSeconds, offline: { id: d.id } });

  let icon = <Download size={variant === "row" ? 14 : 16} />;
  let label = t("player.downloads.download");
  let onClick = () => setChoosing(true);
  if (download?.state === "done") {
    icon = <Play size={variant === "row" ? 14 : 16} fill="currentColor" />;
    label = t("player.downloads.playDownloaded");
    onClick = () => playDownloaded(download);
  } else if (download) {
    icon = download.state === "failed" ? <AlertTriangle size={variant === "row" ? 14 : 16} /> : <ProgressRing value={offlineProgress(download)} size={variant === "row" ? 14 : 16} />;
    label = offlineStatusLabel(download, t);
    onClick = () => setManaging(true);
  }

  const manageActions: SheetAction[] = download
    ? [
        ...(download.state === "failed"
          ? [{ label: t("player.downloads.retry"), icon: <RotateCcw size={18} />, onClick: () => void removeOfflineDownload(download.id).then(() => setChoosing(true)) }]
          : []),
        {
          label: download.state === "failed" ? t("player.downloads.remove") : t("player.downloads.cancel"),
          icon: <Trash2 size={18} />,
          variant: "danger" as const,
          onClick: () => void removeOfflineDownload(download.id),
        },
        { label: t("player.downloads.close"), icon: <X size={18} />, onClick: () => {} },
      ]
    : [];

  return (
    <>
      {variant === "row" ? (
        <button type="button" data-detail-menu onClick={onClick} className={rowClassName}>
          <span className={badgeClassName}>{icon}</span>
          <span className="text-sm font-medium">{label}</span>
          {download?.state !== "done" && <BetaBadge />}
        </button>
      ) : (
        <button
          type="button"
          onClick={onClick}
          data-liquid-pan="wide"
          className={`${wideSpacing} flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white`}
        >
          {icon}
          {label}
          {download?.state !== "done" && <BetaBadge />}
        </button>
      )}
      <OfflineChoiceSheet open={choosing} onClose={() => setChoosing(false)} {...title} />
      <ActionSheet
        open={managing}
        onClose={() => setManaging(false)}
        centerOnWide
        title={title.title}
        subtitle={download ? `${offlineStatusLabel(download, t)} · ${download.audioLabel}` : undefined}
        poster={title.posterUrl}
        actions={manageActions}
      />
    </>
  );
}

export function ProgressRing({ value, size }: { value: number; size: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={`${(value / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 9 9)" />
    </svg>
  );
}

interface Preferences {
  audioLanguage: string | null;
}

/** La fenêtre de choix : piste son et qualité, validées par « Télécharger ». */
function OfflineChoiceSheet({ open, onClose, itemId, radarrId, title, year, posterUrl, runtimeMinutes }: OfflineTitle & { open: boolean; onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const { data: info, error: infoError } = useSWR(open ? ["offline-tracks", itemId] : null, () => fetchDirectInfo(itemId), { revalidateOnFocus: false });
  const { data: prefs } = useSWR<Preferences>(open ? "/api/player/account/preferences" : null, fetcher, { revalidateOnFocus: false });
  const [audio, setAudio] = useState<number | null>(null);
  const [quality, setQuality] = useState<OfflineQuality>("standard");
  const [freeBytes, setFreeBytes] = useState<number | null>(null);

  const tracks = useMemo(() => {
    if (!info) return [];
    const labels = labelAudioTracks(
      info.audio.map((a) => ({ number: a.index, language: a.language, name: a.displayTitle, isDefault: a.isDefault, isForced: false, codecId: a.codec, channels: a.channels, profile: a.profile })),
      {
        locale,
        originalLanguage: info.originalLanguage,
        canaux: (n) => t("player.trackLabel.channels", { n }),
        piste: (n) => t("player.trackLabel.track", { n }),
      }
    );
    return info.audio.map((a, i) => ({ index: a.index, label: labels[i]?.label ?? String(a.index), track: a }));
  }, [info, locale, t]);

  // La piste préchoisie : la langue du compte, sinon celle du fichier par défaut, sinon la première.
  const preferred = useMemo(() => {
    const wanted = normaliseLanguage(prefs?.audioLanguage ?? null);
    const inLanguage = wanted ? tracks.find((x) => trackLanguage({ language: x.track.language, name: x.track.displayTitle, isDefault: x.track.isDefault, isForced: false }) === wanted) : null;
    return (inLanguage ?? tracks.find((x) => x.track.isDefault) ?? tracks[0])?.index ?? null;
  }, [tracks, prefs]);
  const chosen = audio !== null && tracks.some((x) => x.index === audio) ? audio : preferred;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void navigator.storage
      ?.estimate?.()
      .then((e) => {
        if (!cancelled && typeof e.quota === "number" && typeof e.usage === "number") setFreeBytes(e.quota - e.usage);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const runtimeSeconds = info?.runtimeSeconds ?? (runtimeMinutes ? runtimeMinutes * 60 : 0);
  const sizeOf = (q: OfflineQuality) => (runtimeSeconds > 0 ? formatFileSize(expectedBytes(runtimeSeconds, q), locale) : "—");
  const lowSpace = freeBytes !== null && runtimeSeconds > 0 && freeBytes < expectedBytes(runtimeSeconds, quality) * 1.1;

  const start = () => {
    const track = tracks.find((x) => x.index === chosen);
    if (!track) return;
    startOfflineDownload({
      itemId,
      radarrId,
      title,
      year,
      runtimeSeconds,
      posterUrl,
      audioIndex: track.index,
      audioLabel: track.label,
      audioTracks: tracks.map(({ index, label }) => ({ index, label })),
      quality,
      codec: offlineCodec(),
    }).catch((error: unknown) => toast.error(t("player.downloads.startFailed", { error: error instanceof Error ? error.message : String(error) })));
  };

  const choice = (selected: boolean) =>
    `flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors ${selected ? "bg-white/15 text-white" : "text-muted active:bg-white/5"}`;

  return (
    <ActionSheet
      open={open}
      onClose={onClose}
      centerOnWide
      title={title}
      subtitle={t("player.downloads.sheetTitle")}
      poster={posterUrl}
      actions={[
        { label: t("player.downloads.download"), icon: <Download size={18} />, variant: "accent", disabled: chosen === null, onClick: start },
        { label: t("player.downloads.close"), icon: <X size={18} />, onClick: () => {} },
      ]}
    >
      <div className="space-y-4 border-b border-white/10 px-4 py-3">
        <div className="flex justify-end">
          <BetaBadge />
        </div>
        <div>
          <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t("player.downloads.audio")}</p>
          {infoError ? (
            <p className="px-1 text-sm text-warning">{t("player.downloads.tracksFailed")}</p>
          ) : !info ? (
            <p className="px-1 text-sm text-subtle">{t("player.downloads.loadingTracks")}</p>
          ) : (
            <div role="radiogroup" aria-label={t("player.downloads.audio")} className="max-h-[32vh] overflow-y-auto overflow-hidden rounded-2xl bg-white/5">
              {tracks.map((x) => (
                <button key={x.index} type="button" role="radio" aria-checked={x.index === chosen} onClick={() => setAudio(x.index)} className={choice(x.index === chosen)}>
                  <span className="min-w-0 truncate">{x.label}</span>
                  {x.index === chosen && <Check size={16} className="shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t("player.downloads.quality")}</p>
          <div role="radiogroup" aria-label={t("player.downloads.quality")} className="grid grid-cols-2 gap-2">
            {(["standard", "high"] as const).map((q) => (
              <button
                key={q}
                type="button"
                role="radio"
                aria-checked={q === quality}
                onClick={() => setQuality(q)}
                className={`rounded-2xl px-3 py-2.5 text-left transition-colors ${q === quality ? "bg-white/15 ring-1 ring-white/40" : "bg-white/5 active:bg-white/10"}`}
              >
                <span className="block text-sm font-medium text-white">{t(`player.downloads.${q}`)}</span>
                <span className="block text-xs text-subtle">{t(`player.downloads.${q}Hint`, { size: sizeOf(q) })}</span>
              </button>
            ))}
          </div>
        </div>
        {lowSpace && <p className="px-1 text-xs text-warning">{t("player.downloads.lowSpace")}</p>}
        {appleTouch() && <p className="px-1 text-xs text-subtle">{t("player.downloads.keepOpen")}</p>}
      </div>
    </ActionSheet>
  );
}

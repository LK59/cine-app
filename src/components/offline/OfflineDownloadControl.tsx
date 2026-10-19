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
import { formatDurationShort, formatFileSize } from "@/lib/format";
import { normaliseLanguage } from "@/lib/trackPreferences";
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
import { offlineTracks, requestEpisodeDownload, trackForLanguage, type OfflineSeriesRef, type TrackLabeller } from "@/lib/offline/episodeDownloads";
import type { CinemaEpisode, CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

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
export function offlineCodec(): OfflineCodec {
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

export const appleTouch = () => typeof navigator !== "undefined" && isWebKitEngine(navigator.userAgent) && navigator.maxTouchPoints > 1;

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

/** Lisible : fini, ou dont le début est là — sur l'appareil, ou sur le serveur avec du réseau. */
export function offlinePlayable(d: OfflineDownload): boolean {
  return d.state === "done" || (d.state === "downloading" && Math.max(d.bytes, d.serverBytes) > 4 * 1024 * 1024);
}

/**
 * Le téléchargement lisible d'un titre, s'il y en a un — ce qui fait passer « Lire » à « Lire en
 * ligne » et met « Lire le fichier téléchargé » en tête de la fiche (Louis, 19/10/2026).
 */
export function useOfflinePlayable(itemId: string | null | undefined): OfflineDownload | null {
  const enabled = useOfflineDownloadsEnabled();
  const download = useOfflineDownloadFor(itemId);
  // Présent dès la demande (grisé tant que rien n'est lisible), absent après un échec.
  return enabled && download && download.state !== "failed" ? download : null;
}

/**
 * « Lire le fichier téléchargé », en tête de la fiche : la ligne du menu au bureau (le sélecteur la
 * peint en blanc, elle est la première), le bouton blanc pleine largeur au téléphone.
 */
/**
 * La reprise partagée entre « Lire le fichier téléchargé » et « Lire en ligne » (Louis, 19/10/2026) :
 * la plus avancée des deux — celle gardée avec le téléchargement, celle de Jellyfin. La position lue
 * hors ligne part vers Jellyfin dès qu'il y a du réseau (`saveOfflinePosition`), et le serveur ne fait
 * qu'avancer une position : les deux finissent d'accord.
 */
export function sharedResumeSeconds(download: OfflineDownload, onlineResumeTicks: number | null | undefined): number {
  return Math.max(download.positionSeconds || 0, onlineResumeTicks ? onlineResumeTicks / 1e7 : 0);
}

/** Les deux libellés, avec le temps restant quand il y a une reprise. */
export function offlinePlayLabels(
  t: ReturnType<typeof useT>,
  resumeSeconds: number,
  runtimeSeconds: number | null | undefined,
  complete = true
): { offline: string; online: string } {
  if (resumeSeconds < 30 || !runtimeSeconds) {
    return { offline: t(complete ? "player.downloads.playDownloaded" : "player.downloads.playDownloading"), online: t("player.downloads.playOnline") };
  }
  const time = t("cinema.timeRemaining", { time: formatDurationShort(Math.max(0, runtimeSeconds - resumeSeconds) * 1e7) });
  return {
    offline: t(complete ? "player.downloads.resumeDownloaded" : "player.downloads.resumeDownloading", { time }),
    online: t("player.downloads.resumeOnline", { time }),
  };
}

export function OfflinePlayButton({
  download,
  variant,
  onlineResumeTicks,
  rowClassName = "",
  badgeClassName = "",
}: {
  download: OfflineDownload;
  variant: "row" | "wide";
  /** La reprise que Jellyfin connaît pour ce titre, celle que « Lire en ligne » prendrait. */
  onlineResumeTicks?: number | null;
  rowClassName?: string;
  badgeClassName?: string;
}) {
  const t = useT();
  const playback = usePlayback();
  const resume = sharedResumeSeconds(download, onlineResumeTicks);
  const label = offlinePlayLabels(t, resume, download.runtimeSeconds, download.state === "done").offline;
  // Grisé tant qu'il n'y a pas de quoi démarrer (préparation, tout début) ; cliquable ensuite.
  const ready = offlinePlayable(download);
  const play = () => ready && playback.play({ itemId: download.itemId, title: download.title, resumeAt: resume, offline: { id: download.id } });
  return variant === "row" ? (
    <button type="button" data-detail-menu onClick={play} disabled={!ready} className={`${rowClassName} ${ready ? "" : "cursor-default opacity-45"}`}>
      <span className={badgeClassName}>
        <Play size={14} fill="currentColor" />
      </span>
      <span className="text-sm font-medium">{label}</span>
    </button>
  ) : (
    <button
      type="button"
      onClick={play}
      disabled={!ready}
      data-liquid-pan="wide"
      className={`mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-base font-semibold text-ink ${ready ? "" : "opacity-45"}`}
    >
      <Play size={18} fill="currentColor" />
      {label}
    </button>
  );
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
  if (download) {
    icon = download.state === "failed" ? <AlertTriangle size={variant === "row" ? 14 : 16} /> : <ProgressRing value={offlineProgress(download)} size={variant === "row" ? 14 : 16} />;
    label = offlineStatusLabel(download, t);
    onClick = () => setManaging(true);
  }

  const earlyPlayable = download && offlinePlayable(download) && download.state !== "done" ? download : null;

  const manageActions: SheetAction[] = download
    ? [
        ...(earlyPlayable ? [{ label: t("player.downloads.playDownloaded"), icon: <Play size={18} />, onClick: () => playDownloaded(earlyPlayable) }] : []),
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

  // Fini : la ligne disparaît — « Lire le fichier téléchargé » a pris la tête de la fiche
  // (`OfflinePlayButton`), et le gestionnaire s'occupe de la suppression.
  if (download?.state === "done") return null;

  return (
    <>
      {variant === "row" ? (
        <button type="button" data-detail-menu onClick={onClick} className={rowClassName}>
          <span className={badgeClassName}>{icon}</span>
          <span className="text-sm font-medium">{label}</span>
          <BetaBadge />
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
          <BetaBadge />
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

/** La langue audio du compte (préférence Jellyfin), lue quand une fenêtre de choix s'ouvre. */
export function useAccountAudioLanguage(open: boolean): string | null {
  const { data: prefs } = useSWR<Preferences>(open ? "/api/player/account/preferences" : null, fetcher, { revalidateOnFocus: false });
  return normaliseLanguage(prefs?.audioLanguage ?? null);
}

/** Les traductions des étiquettes de pistes, pour `offlineTracks`. */
export function useTrackLabeller(): TrackLabeller {
  const t = useT();
  const { locale } = useLocale();
  return useMemo(
    () => ({ locale, canaux: (n: number) => t("player.trackLabel.channels", { n }), piste: (n: number) => t("player.trackLabel.track", { n }) }),
    [locale, t]
  );
}

/**
 * La place libre de l'appareil, lue à l'ouverture d'une fenêtre de choix — pour prévenir, jamais pour
 * refuser. Chrome ne dit pas la vraie place : il annonce un quota d'environ « ce qui est utilisé
 * + 10 Gio » (pour ne pas laisser deviner le disque, en navigation privée surtout), si bien que
 * l'avertissement peut sortir alors que le disque a la place — un avertissement donc, et un bouton
 * qui reste ouvert.
 */
export function useFreeBytes(open: boolean): number | null {
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
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
  return freeBytes;
}

/** Les deux qualités, avec la taille que chacune pèserait. */
export function QualityPicker({ quality, onChange, bytesFor }: { quality: OfflineQuality; onChange: (q: OfflineQuality) => void; bytesFor: (q: OfflineQuality) => number }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <div>
      <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t("player.downloads.quality")}</p>
      <div role="radiogroup" aria-label={t("player.downloads.quality")} className="grid grid-cols-2 gap-2">
        {(["standard", "high"] as const).map((q) => {
          const bytes = bytesFor(q);
          return (
            <button
              key={q}
              type="button"
              role="radio"
              aria-checked={q === quality}
              onClick={() => onChange(q)}
              className={`rounded-2xl px-3 py-2.5 text-left transition-colors ${q === quality ? "bg-white/15 ring-1 ring-white/40" : "bg-white/5 active:bg-white/10"}`}
            >
              <span className="block text-sm font-medium text-white">{t(`player.downloads.${q}`)}</span>
              <span className="block text-xs text-subtle">{t(`player.downloads.${q}Hint`, { size: bytes > 0 ? formatFileSize(bytes, locale) : "—" })}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * « Télécharger automatiquement l'épisode suivant » — un interrupteur, ouvert par défaut (carte
 * blanche de Louis, 19/10/2026) : à la moitié d'un épisode lu hors ligne, le suivant se télécharge ;
 * un épisode vu jusqu'au bout s'efface une fois le suivant arrivé.
 */
export function AutoNextToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex w-full items-center justify-between gap-3 rounded-2xl bg-white/5 px-3 py-2.5 text-left">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-white">{t("player.downloads.autoNext")}</span>
        <span className="block text-xs text-subtle">{t("player.downloads.autoNextHint")}</span>
      </span>
      <span aria-hidden className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? "bg-accent-500" : "bg-white/20"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}

/** Un épisode à télécharger : sa série, et la liste où chercher celui qui le suit. */
export interface OfflineEpisodeTarget {
  series: OfflineSeriesRef;
  episode: CinemaEpisode;
  seasons: CinemaSeason[];
}

/**
 * La fenêtre de choix : piste son et qualité, validées par « Télécharger ». Pour un épisode
 * (`episode`), la même fenêtre, plus le téléchargement automatique de l'épisode suivant.
 */
export function OfflineChoiceSheet({
  open,
  onClose,
  itemId,
  radarrId,
  title,
  year,
  posterUrl,
  runtimeMinutes,
  episode,
}: OfflineTitle & { open: boolean; onClose: () => void; episode?: OfflineEpisodeTarget }) {
  const t = useT();
  const toast = useToast();
  const labeller = useTrackLabeller();
  const { data: info, error: infoError } = useSWR(open ? ["offline-tracks", itemId] : null, () => fetchDirectInfo(itemId), { revalidateOnFocus: false });
  const wanted = useAccountAudioLanguage(open);
  const [audio, setAudio] = useState<number | null>(null);
  const [quality, setQuality] = useState<OfflineQuality>("standard");
  const [autoNext, setAutoNext] = useState(true);
  const freeBytes = useFreeBytes(open);

  const tracks = useMemo(() => (info ? offlineTracks(info, labeller) : []), [info, labeller]);

  // La piste préchoisie : la langue du compte, sinon celle du fichier par défaut, sinon la première.
  const preferred = useMemo(() => trackForLanguage(tracks, wanted)?.index ?? null, [tracks, wanted]);
  const chosen = audio !== null && tracks.some((x) => x.index === audio) ? audio : preferred;

  const runtimeSeconds = info?.runtimeSeconds ?? (runtimeMinutes ? runtimeMinutes * 60 : 0);
  const lowSpace = freeBytes !== null && runtimeSeconds > 0 && freeBytes < expectedBytes(runtimeSeconds, quality) * 1.1;

  const start = () => {
    const track = tracks.find((x) => x.index === chosen);
    if (!track) return;
    const failed = (error: unknown) => toast.error(t("player.downloads.startFailed", { error: error instanceof Error ? error.message : String(error) }));
    if (episode) {
      requestEpisodeDownload(episode.series, episode.episode, episode.seasons, { language: null, audioIndex: track.index, quality, codec: offlineCodec(), autoNext }, labeller).catch(failed);
      return;
    }
    startOfflineDownload({
      itemId,
      radarrId,
      title,
      year,
      runtimeSeconds,
      audioIndex: track.index,
      audioLabel: track.label,
      audioTracks: tracks.map(({ index, label }) => ({ index, label })),
      quality,
      codec: offlineCodec(),
    }).catch(failed);
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
            <p className="px-1 text-sm text-warning">{t(episode ? "player.downloads.tracksFailedEpisode" : "player.downloads.tracksFailed")}</p>
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
        <QualityPicker quality={quality} onChange={setQuality} bytesFor={(q) => (runtimeSeconds > 0 ? expectedBytes(runtimeSeconds, q) : 0)} />
        {episode && <AutoNextToggle on={autoNext} onChange={setAutoNext} />}
        {lowSpace && <p className="px-1 text-xs text-warning">{t("player.downloads.lowSpace")}</p>}
        {appleTouch() && <p className="px-1 text-xs text-subtle">{t("player.downloads.keepOpen")}</p>}
      </div>
    </ActionSheet>
  );
}

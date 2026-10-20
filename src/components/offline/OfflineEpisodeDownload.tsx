"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, ArrowDownToLine, Check, CircleCheck, Download, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { useToast } from "@/components/Toast";
import { fetchDirectInfo } from "@/lib/directInfo";
import { formatFileSize } from "@/lib/format";
import { apiErrorText } from "@/lib/apiErrorText";
import { useOfflineDownloadsEnabled } from "@/lib/offline/useOfflineEnabled";
import { deviceStoreSupported } from "@/lib/offline/deviceStore";
import {
  initOfflineDownloads,
  offlineEpisodesOf,
  pauseOfflineDownload,
  removeOfflineDownload,
  resumeOfflineDownload,
  retryOfflineDownload,
  useOfflineDownloadFor,
  useOfflineDownloads,
  type OfflineDownload,
} from "@/lib/offline/downloads";
import {
  audioTrackLanguage,
  episodesToDownload,
  estimatedEpisodesBytes,
  requestSeasonDownloads,
  type OfflineSeriesRef,
} from "@/lib/offline/episodeDownloads";
import type { OfflineQuality } from "@/lib/offline/quality";
import type { CinemaEpisode, CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import {
  AutoNextToggle,
  BetaBadge,
  OfflineChoiceSheet,
  ProgressRing,
  QualityPicker,
  touchDevice,
  offlineCodec,
  offlinePlayable,
  offlineProgress,
  offlineStatusLabel,
  sharedResumeSeconds,
  useAccountAudioLanguage,
  useFreeBytes,
  useTrackLabeller,
} from "./OfflineDownloadControl";

/**
 * Le téléchargement hors ligne des épisodes (bêta, 19/10/2026) — le petit bouton de chaque ligne
 * d'épisode, à la Netflix, et « Télécharger la saison ». Les mêmes composants pour la liste des
 * épisodes du bureau (`CinemaEpisodeBrowser`) et la fiche du téléphone (`CinemaMobileDetail`) : ils
 * ne diffèrent que par la taille (`size`).
 *
 * Discret, voulu par Louis (« interface épurée ») : une icône qui dit l'état — rien, préparation,
 * anneau d'avancement, téléchargé —, et tout le reste dans une feuille qu'elle ouvre. La lecture en
 * ligne de la ligne ne change pas ; lire le fichier téléchargé passe par cette icône.
 */

/** Ouvert et possible ici — sinon rien n'est monté, ni magasin ni fenêtre. */
export function useOfflineEpisodesOn(): boolean {
  const enabled = useOfflineDownloadsEnabled();
  const [supported] = useState(deviceStoreSupported);
  return enabled && supported;
}

/**
 * Le chargement des téléchargements de l'appareil, une fois pour toute une liste : chaque ligne le
 * demande à son montage, et vingt-quatre lignes lisaient vingt-quatre fois le dossier de l'appareil.
 */
let initPending: Promise<void> | null = null;
function initOnce(): Promise<void> {
  initPending ??= initOfflineDownloads().finally(() => {
    initPending = null;
  });
  return initPending;
}

/** Rend le focus au bouton qui a ouvert une feuille, si personne ne l'a pris : les flèches de la liste en dépendent. */
function restoreFocus(ref: React.RefObject<HTMLButtonElement | null>) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus({ preventScroll: true });
  });
}

export function OfflineEpisodeButton(props: {
  series: OfflineSeriesRef;
  seasons: CinemaSeason[];
  episode: CinemaEpisode;
  posterUrl?: string | null;
  size: "desktop" | "phone";
  className?: string;
}) {
  return useOfflineEpisodesOn() ? <OfflineEpisodeButtonOn {...props} /> : null;
}

function OfflineEpisodeButtonOn({
  series,
  seasons,
  episode,
  posterUrl,
  size,
  className = "",
}: {
  series: OfflineSeriesRef;
  seasons: CinemaSeason[];
  episode: CinemaEpisode;
  posterUrl?: string | null;
  size: "desktop" | "phone";
  className?: string;
}) {
  const t = useT();
  const download = useOfflineDownloadFor(episode.jellyfinItemId);
  const [choosing, setChoosing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void initOnce();
  }, []);

  const iconSize = size === "desktop" ? 20 : 18;
  const label = t("player.downloads.downloadEpisode");
  const box = size === "desktop" ? "h-11 w-11" : "h-10 w-10";
  const poster = episode.thumbnailUrl ?? posterUrl ?? null;
  return (
    <>
      {download ? (
        <DownloadStateButton
          download={download}
          name={`${episode.episodeNumber}. ${episode.title}`}
          poster={poster}
          onlineResumeTicks={episode.resumeTicks}
          size={size}
          className={className}
          onRetry={() => setChoosing(true)}
        />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          data-episode-download="true"
          data-download-state="none"
          aria-label={`${label} — ${episode.episodeNumber}. ${episode.title}`}
          title={label}
          onClick={() => setChoosing(true)}
          className={`${box} ${className} ${STATE_BUTTON}`}
        >
          <ArrowDownToLine size={iconSize} />
        </button>
      )}
      <OfflineChoiceSheet
        open={choosing}
        onClose={() => {
          setChoosing(false);
          restoreFocus(buttonRef);
        }}
        itemId={episode.jellyfinItemId}
        radarrId={null}
        title={`${episode.episodeNumber}. ${episode.title}`}
        year={null}
        posterUrl={poster}
        runtimeMinutes={episode.runtimeMinutes}
        episode={{ series, episode, seasons }}
      />
    </>
  );
}

const STATE_BUTTON =
  "flex shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white focus-visible:outline-none active:bg-white/15";

/**
 * L'icône d'un téléchargement qui existe — préparation (l'anneau vide qui respire), anneau qui se
 * remplit, téléchargé, échec — et la feuille qu'elle ouvre : lire, mettre en pause ou reprendre,
 * annuler ou supprimer (confirmé une fois fini). Une seule pièce pour la ligne d'épisode de la fiche
 * en ligne et pour celle de la fiche hors ligne (`OfflineDownloadsView`), qui ne doivent pas dire
 * deux choses différentes du même fichier.
 */
export function DownloadStateButton({
  download,
  name,
  poster,
  onlineResumeTicks,
  size,
  className = "",
  onRetry,
}: {
  download: OfflineDownload;
  /** Ce que la feuille et le lecteur d'écran nomment (« 5. Marques de bronzage »). */
  name: string;
  poster: string | null;
  /** La reprise de Jellyfin quand on la connaît (fiche en ligne) ; sinon celle de l'appareil. */
  onlineResumeTicks?: number | null;
  size: "desktop" | "phone";
  className?: string;
  /** Un échec se retente par la fenêtre de choix de l'appelant ; sans elle, aux mêmes choix (`retryOfflineDownload`). */
  onRetry?: () => void;
}) {
  const t = useT();
  const playback = usePlayback();
  const [managing, setManaging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const iconSize = size === "desktop" ? 20 : 18;
  const state = episodeDownloadState(download);
  const label = offlineStatusLabel(download, t);
  const icon =
    state === "done" ? (
      <CircleCheck size={iconSize} className="text-accent-400" />
    ) : state === "failed" ? (
      <AlertTriangle size={iconSize} className="text-warning" />
    ) : download.state === "paused" ? (
      <Pause size={iconSize} />
    ) : (
      <span className={state === "preparing" ? "animate-pulse" : undefined}>
        <ProgressRing value={offlineProgress(download)} size={iconSize} />
      </span>
    );
  const play = () =>
    playback.play({ itemId: download.itemId, title: download.title, resumeAt: sharedResumeSeconds(download, onlineResumeTicks), offline: { id: download.id } });
  const actions: SheetAction[] =
    download.state === "failed"
      ? [
          {
            label: t("player.downloads.retry"),
            icon: <RotateCcw size={18} />,
            // Par la fenêtre de choix de l'appelant s'il en a une (fiche en ligne), sinon aux mêmes choix.
            onClick: () => void (onRetry ? removeOfflineDownload(download.id).then(onRetry) : retryOfflineDownload(download.id)),
          },
          { label: t("player.downloads.remove"), icon: <Trash2 size={18} />, variant: "danger", onClick: () => void removeOfflineDownload(download.id) },
          { label: t("player.downloads.close"), icon: <X size={18} />, onClick: () => {} },
        ]
      : [
          {
            label: t(download.state === "done" ? "player.downloads.playDownloaded" : "player.downloads.playDownloading"),
            icon: <Play size={18} />,
            disabled: !offlinePlayable(download),
            onClick: play,
          },
          ...(download.state === "paused"
            ? [{ label: t("player.downloads.resumeDownload"), icon: <Download size={18} />, onClick: () => void resumeOfflineDownload(download.id) }]
            : download.state !== "done"
              ? [{ label: t("player.downloads.pause"), icon: <Pause size={18} />, onClick: () => void pauseOfflineDownload(download.id) }]
              : []),
          // Supprimer, toujours confirmé (Louis, 19/10/2026) — annuler aussi : des centaines de Mo
          // déjà arrivés se perdent pareil.
          {
            label: t(download.state === "done" ? "player.downloads.remove" : "player.downloads.cancel"),
            icon: <Trash2 size={18} />,
            variant: "danger",
            onClick: () => setConfirming(true),
          },
          { label: t("player.downloads.close"), icon: <X size={18} />, onClick: () => {} },
        ];
  const box = size === "desktop" ? "h-11 w-11" : "h-10 w-10";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-episode-download="true"
        data-download-state={state}
        aria-label={`${label} — ${name}`}
        title={label}
        onClick={() => setManaging(true)}
        className={`${box} ${className} ${STATE_BUTTON}`}
      >
        {icon}
      </button>
      <ActionSheet
        open={managing}
        onClose={() => {
          setManaging(false);
          restoreFocus(buttonRef);
        }}
        centerOnWide
        title={name}
        subtitle={`${label} · ${download.audioLabel}`}
        poster={poster}
        actions={actions}
      />
      <ActionSheet
        open={confirming}
        onClose={() => {
          setConfirming(false);
          restoreFocus(buttonRef);
        }}
        role="alertdialog"
        centerOnWide
        title={name}
        subtitle={t("player.downloads.confirmRemove")}
        actions={[
          {
            label: t(download.state === "done" ? "player.downloads.remove" : "player.downloads.cancel"),
            icon: <Trash2 size={18} />,
            variant: "danger",
            noAutoFocus: true,
            onClick: () => void removeOfflineDownload(download.id),
          },
          { label: t("common.cancel"), onClick: () => {} },
        ]}
      />
    </>
  );
}

export type EpisodeDownloadState = "none" | "preparing" | "downloading" | "done" | "failed";

/** L'état que l'icône d'une ligne montre. */
export function episodeDownloadState(d: OfflineDownload | null): EpisodeDownloadState {
  if (!d) return "none";
  if (d.state === "done" || d.state === "failed") return d.state;
  return d.state === "preparing" || d.bytes === 0 ? "preparing" : "downloading";
}

/** Le nom d'une langue dans la langue de l'interface (`Intl.DisplayNames`), avec sa majuscule. */
function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return code;
  }
}

/**
 * « Télécharger la saison » : la taille estimée sur le bouton, une seule question — la langue, la
 * qualité, le téléchargement automatique —, appliquée à chaque épisode qui n'est pas sur l'appareil.
 */
export function OfflineSeasonDownload(props: {
  series: OfflineSeriesRef;
  seasons: CinemaSeason[];
  seasonNumber: number;
  posterUrl?: string | null;
  size: "desktop" | "phone";
}) {
  return useOfflineEpisodesOn() ? <OfflineSeasonDownloadOn {...props} /> : null;
}

function OfflineSeasonDownloadOn({
  series,
  seasons,
  seasonNumber,
  posterUrl,
  size,
}: {
  series: OfflineSeriesRef;
  seasons: CinemaSeason[];
  seasonNumber: number;
  posterUrl?: string | null;
  size: "desktop" | "phone";
}) {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const labeller = useTrackLabeller();
  const downloads = useOfflineDownloads();
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<string | null | undefined>(undefined);
  const [quality, setQuality] = useState<OfflineQuality>("standard");
  const [autoNext, setAutoNext] = useState(true);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const freeBytes = useFreeBytes(open);
  const wanted = useAccountAudioLanguage(open);

  useEffect(() => {
    void initOnce();
  }, []);

  const episodes = useMemo(() => seasons.find((s) => s.seasonNumber === seasonNumber)?.episodes ?? [], [seasons, seasonNumber]);
  const remaining = useMemo(() => episodesToDownload(episodes, downloads), [episodes, downloads]);
  // Les langues proposées : celles du premier épisode à télécharger. Les pistes d'une saison
  // diffèrent d'un épisode à l'autre — ordre, titres, commentaires —, ses langues presque jamais ; et
  // un épisode qui n'a pas la langue choisie garde sa piste par défaut.
  const probe = remaining[0]?.jellyfinItemId ?? null;
  const { data: info, error: infoError } = useSWR(open && probe ? ["offline-tracks", probe] : null, () => fetchDirectInfo(probe!), { revalidateOnFocus: false });
  const languages = useMemo(() => {
    const seen: string[] = [];
    for (const a of info?.audio ?? []) {
      const lang = audioTrackLanguage(a);
      if (lang && !seen.includes(lang)) seen.push(lang);
    }
    return seen;
  }, [info]);
  const defaultLanguage = useMemo(() => {
    const fromDefault = info?.audio.find((a) => a.isDefault);
    return (wanted && languages.includes(wanted) ? wanted : fromDefault ? audioTrackLanguage(fromDefault) : null) ?? languages[0] ?? null;
  }, [info, languages, wanted]);
  const chosenLanguage = language !== undefined && (language === null || languages.includes(language)) ? language : defaultLanguage;

  if (episodes.length === 0) return null;

  const total = estimatedEpisodesBytes(remaining, "standard");
  const chosenBytes = estimatedEpisodesBytes(remaining, quality);
  const lowSpace = freeBytes !== null && chosenBytes > 0 && freeBytes < chosenBytes * 1.1;

  const start = () => {
    void requestSeasonDownloads(
      series,
      remaining,
      seasons,
      { language: chosenLanguage, quality, codec: offlineCodec(), autoNext },
      labeller,
      // Relu à chaque épisode (`offlineEpisodesOf` lit l'état du moment, pas celui de ce rendu).
      () => offlineEpisodesOf(series.sonarrId, series.seriesTitle)
    ).then(({ failed }) => {
      if (failed.length) toast.error(t("player.downloads.seasonFailed", { n: failed.length, error: apiErrorText(failed[0].cause, t, locale, failed[0].error) }));
    });
  };

  const done = remaining.length === 0;
  const text = done ? t("player.downloads.seasonDone") : t("player.downloads.downloadSeason", { size: total > 0 ? formatFileSize(total, locale) : "—" });
  const option = (selected: boolean) =>
    `flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors ${selected ? "bg-white/15 text-white" : "text-muted active:bg-white/5"}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-season-download="true"
        disabled={done}
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none ${
          done ? "text-subtle" : "bg-white/10 text-white hover:bg-white/15 focus-visible:bg-white/20 active:bg-white/15"
        } ${size === "desktop" ? "" : "shrink-0"}`}
      >
        {done ? <Check size={14} /> : <ArrowDownToLine size={14} />}
        {text}
      </button>
      <ActionSheet
        open={open}
        onClose={() => {
          setOpen(false);
          restoreFocus(buttonRef);
        }}
        centerOnWide
        title={`${series.seriesTitle} — ${seasonNumber === 0 ? t("cinema.specials") : t("cinema.season", { n: seasonNumber })}`}
        subtitle={t("player.downloads.seasonSheet", { n: remaining.length })}
        poster={posterUrl ?? null}
        actions={[
          { label: t("player.downloads.download"), icon: <Download size={18} />, variant: "accent", disabled: remaining.length === 0 || !info, onClick: start },
          { label: t("player.downloads.close"), icon: <X size={18} />, onClick: () => {} },
        ]}
      >
        <div className="space-y-4 border-b border-white/10 px-4 py-3">
          <div className="flex justify-end">
            <BetaBadge />
          </div>
          <div>
            <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t("player.downloads.language")}</p>
            {infoError ? (
              <p className="px-1 text-sm text-warning">{t("player.downloads.tracksFailedEpisode")}</p>
            ) : !info ? (
              <p className="px-1 text-sm text-subtle">{t("player.downloads.loadingTracks")}</p>
            ) : (
              <div role="radiogroup" aria-label={t("player.downloads.language")} className="max-h-[28vh] overflow-y-auto overflow-hidden rounded-2xl bg-white/5">
                {(languages.length ? languages : [null]).map((lang) => (
                  <button key={lang ?? "default"} type="button" role="radio" aria-checked={lang === chosenLanguage} onClick={() => setLanguage(lang)} className={option(lang === chosenLanguage)}>
                    <span className="min-w-0 truncate">{lang ? languageName(lang, locale) : t("player.downloads.defaultTrack")}</span>
                    {lang === chosenLanguage && <Check size={16} className="shrink-0" />}
                  </button>
                ))}
              </div>
            )}
            <p className="px-1 pt-1.5 text-xs text-subtle">{t("player.downloads.languageHint")}</p>
          </div>
          <QualityPicker quality={quality} onChange={setQuality} bytesFor={(q) => estimatedEpisodesBytes(remaining, q)} />
          <AutoNextToggle on={autoNext} onChange={setAutoNext} />
          {lowSpace && <p className="px-1 text-xs text-warning">{t("player.downloads.lowSpace")}</p>}
          {touchDevice() && <p className="px-1 text-xs text-subtle">{t("player.downloads.keepOpen")}</p>}
        </div>
      </ActionSheet>
    </>
  );
}

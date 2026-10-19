"use client";

import { useEffect, useState } from "react";
import { Check, Download, Film, HardDrive, Pause, Play, Trash2, Tv, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { formatDurationShort, formatFileSize } from "@/lib/format";
import { deviceStore } from "@/lib/offline/deviceStore";
import { offlineAccount, pauseOfflineDownload, removeOfflineDownload, resumeOfflineDownload, useOfflineDownloads, type OfflineDownload } from "@/lib/offline/downloads";
import { groupOfflineDownloads, offlineRemainingSeconds, type OfflineSeriesGroup } from "@/lib/offline/downloadGroups";
import { offlinePlayable, offlineProgress, offlineStatusLabel } from "./OfflineDownloadControl";

/**
 * La page des téléchargements (bêta, DECISIONS.md §109) — le contenu seul, monté par deux cadres :
 * le panneau du cinéma (`PlayerDownloadsPanel`, `#telechargements=1`) et l'entrée hors ligne
 * (`/hors-ligne`), servie par le service worker quand le serveur ne répond pas. Un seul dessin pour
 * les deux, pour que la page qu'on retrouve sans réseau soit celle qu'on connaît.
 *
 * Tout ce qui s'y lit vient de l'appareil — la liste, les affiches, la place —, rien du serveur :
 * c'est ce qui la rend utilisable hors ligne. « Ouvrir la fiche » n'existe que dans le cinéma
 * (`onOpenTitle`) : sans serveur, il n'y a pas de fiche à ouvrir.
 */

export interface OfflineOpenTarget {
  type: "movie" | "series";
  id: number;
}

export function OfflineDownloadsView({ onOpenTitle }: { onOpenTitle?: (target: OfflineOpenTarget) => void }) {
  const t = useT();
  const downloads = useOfflineDownloads();
  const { films, series } = groupOfflineDownloads(downloads);
  return (
    <div className="space-y-9 [@media(max-height:500px)]:space-y-6">
      <StorageSummary downloads={downloads} />
      {downloads.length === 0 ? (
        <p className="rounded-2xl bg-white/4 px-5 py-10 text-center text-sm text-muted ring-1 ring-inset ring-white/8">{t("player.downloads.empty")}</p>
      ) : (
        <>
          {films.length > 0 && (
            <Group icon={Film} title={t("player.downloads.films")}>
              {films.map((d) => (
                <DownloadRow key={d.id} download={d} onOpenTitle={onOpenTitle} />
              ))}
            </Group>
          )}
          {series.length > 0 && (
            <Group icon={Tv} title={t("player.downloads.series")}>
              {series.map((s) => (
                <SeriesBlock key={s.key} group={s} onOpenTitle={onOpenTitle} />
              ))}
            </Group>
          )}
        </>
      )}
    </div>
  );
}

/** Le titre en petites capitales au-dessus d'une carte — la forme des groupes du Compte. */
function Group({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2.5 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-subtle">
        <Icon size={13} aria-hidden />
        {title}
      </h2>
      <ul className="rounded-2xl bg-white/4 px-3 ring-1 ring-inset ring-white/8 sm:px-4">{children}</ul>
    </section>
  );
}

/**
 * La place sur l'appareil : ce que prennent les téléchargements de ce compte, et ce que le
 * navigateur dit pouvoir encore accorder à l'application (`navigator.storage.estimate`, une
 * estimation — Safari la donne large, d'où « environ »).
 */
function StorageSummary({ downloads }: { downloads: OfflineDownload[] }) {
  const t = useT();
  const { locale } = useLocale();
  const used = downloads.reduce((sum, d) => sum + d.bytes, 0);
  const [free, setFree] = useState<number | null>(null);
  // Relue quand la place prise change de plus de quelques Mo : un téléchargement en cours la fait
  // bouger toutes les deux secondes, l'estimation n'a pas à suivre chaque morceau.
  const step = Math.round(used / (64 * 1024 * 1024));
  useEffect(() => {
    let cancelled = false;
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!storage?.estimate) return;
    storage
      .estimate()
      .then((e) => {
        if (!cancelled && typeof e.quota === "number" && typeof e.usage === "number") setFree(Math.max(0, e.quota - e.usage));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [step]);
  const total = free !== null ? used + free : null;
  const share = total ? Math.min(100, Math.max(used > 0 ? 1.5 : 0, (used / total) * 100)) : 0;
  return (
    <div className="rounded-2xl bg-white/4 px-4 py-4 ring-1 ring-inset ring-white/8 sm:px-5">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/8 text-white">
          <HardDrive size={17} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">{t("player.downloads.storageTitle")}</p>
          <p className="text-xs text-subtle">
            {t("player.downloads.storageUsed", { size: formatFileSize(used, locale) })}
            {free !== null && <> · {t("player.downloads.storageFree", { size: formatFileSize(free, locale) })}</>}
          </p>
        </div>
      </div>
      {total !== null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
          <div className="h-full rounded-full bg-white/80" style={{ width: `${share}%` }} />
        </div>
      )}
    </div>
  );
}

function SeriesBlock({ group, onOpenTitle }: { group: OfflineSeriesGroup; onOpenTitle?: (target: OfflineOpenTarget) => void }) {
  const t = useT();
  const { locale } = useLocale();
  const poster = usePosterUrl(group.first);
  const count = group.seasons.reduce((n, s) => n + s.episodes.length, 0);
  return (
    <li className="border-t border-white/8 py-3.5 first:border-t-0">
      <div className="flex items-center gap-3">
        <Poster url={poster} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-semibold text-white">{group.title}</p>
          <p className="truncate text-xs text-subtle">
            {t("player.downloads.episodes", { n: count })} · {formatFileSize(group.bytes, locale)}
          </p>
        </div>
        {onOpenTitle && group.sonarrId !== null && (
          <IconButton label={t("player.downloads.openSeries")} onClick={() => onOpenTitle({ type: "series", id: group.sonarrId! })}>
            <Tv size={15} />
          </IconButton>
        )}
      </div>
      {group.seasons.map((season) => (
        <div key={season.season} className="mt-3">
          <p className="mb-1 pl-1 text-[11px] font-medium uppercase tracking-wide text-subtle">{t("player.downloads.season", { n: season.season })}</p>
          <ul className="rounded-xl bg-white/3 px-2.5 ring-1 ring-inset ring-white/6">
            {season.episodes.map((d) => (
              <DownloadRow key={d.id} download={d} episode />
            ))}
          </ul>
        </div>
      ))}
    </li>
  );
}

function Poster({ url, small = false }: { url: string | null; small?: boolean }) {
  const size = small ? "h-12 w-8" : "h-[4.5rem] w-12";
  return url ? (
    // Une adresse `blob:` de l'affiche gardée sur l'appareil : rien à optimiser par le serveur.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className={`${size} shrink-0 rounded-lg object-cover`} />
  ) : (
    <span className={`flex ${size} shrink-0 items-center justify-center rounded-lg bg-white/8 text-subtle`}>
      <Film size={16} aria-hidden />
    </span>
  );
}

function IconButton({
  label,
  onClick,
  disabled = false,
  tone = "ghost",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "primary" | "ghost" | "danger";
  children: React.ReactNode;
}) {
  const colors = tone === "primary" ? "bg-white text-ink" : tone === "danger" ? "bg-white/8 text-danger" : "bg-white/8 text-white";
  return (
    <button
      type="button"
      data-nav-item
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-opacity ${colors} ${disabled ? "cursor-default opacity-35" : ""}`}
    >
      {children}
    </button>
  );
}

/**
 * Une ligne : un film (avec son affiche) ou un épisode (son numéro à la place). Ce qu'on veut savoir
 * d'un téléchargement avant de partir sans réseau : est-il là en entier, en quelle qualité et quelle
 * langue, combien il pèse, et où on en était.
 */
function DownloadRow({ download: d, episode = false, onOpenTitle }: { download: OfflineDownload; episode?: boolean; onOpenTitle?: (target: OfflineOpenTarget) => void }) {
  const t = useT();
  const { locale } = useLocale();
  const playback = usePlayback();
  const poster = usePosterUrl(episode ? null : d);
  const [confirming, setConfirming] = useState(false);
  const done = d.state === "done";
  const failed = d.state === "failed";
  const playable = offlinePlayable(d);
  const pct = offlineProgress(d);
  const remaining = offlineRemainingSeconds(d);
  const quality = t(`player.downloads.${d.quality}`);
  const title = episode && d.episode ? d.episode.episodeTitle || d.title : d.title;
  const removeLabel = done || failed ? t("player.downloads.remove") : t("player.downloads.cancel");
  const playLabel = t(done ? "player.downloads.playDownloaded" : "player.downloads.playDownloading");
  return (
    <li className={`flex items-center gap-3 border-t border-white/8 first:border-t-0 ${episode ? "py-2.5" : "py-3.5"}`}>
      {episode ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/8 text-xs font-semibold tabular-nums text-white">
          {d.episode?.episodeNumber ?? "–"}
        </span>
      ) : (
        <Poster url={poster} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          {title}
          {!episode && d.year ? <span className="font-normal text-subtle"> · {d.year}</span> : null}
        </p>
        <p className="truncate text-xs text-subtle">
          {quality} · {d.audioLabel}
          {done ? <> · {formatFileSize(d.bytes, locale)}</> : null}
        </p>
        {done ? (
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
            <Check size={12} className="shrink-0 text-success" aria-hidden />
            <span className="truncate">
              {d.watchedToEnd
                ? t("player.downloads.watched")
                : remaining !== null
                  ? `${t("player.downloads.stoppedAt", { time: formatDurationShort(d.positionSeconds * 1e7) })} · ${t("cinema.timeRemaining", { time: formatDurationShort(remaining * 1e7) })}`
                  : offlineStatusLabel(d, t)}
            </span>
          </p>
        ) : failed ? (
          <p className="mt-0.5 truncate text-xs text-warning">
            {offlineStatusLabel(d, t)}
            {d.error ? ` · ${d.error}` : ""}
          </p>
        ) : (
          <div className="mt-1.5">
            <div
              className="h-1 overflow-hidden rounded-full bg-white/12"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={offlineStatusLabel(d, t)}
            >
              <div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${d.bytes > 0 ? Math.max(2, pct) : 0}%` }} />
            </div>
            <p className="mt-1 truncate text-[11px] text-subtle">
              {offlineStatusLabel(d, t)}
              {d.expectedBytes > 0 && d.bytes > 0
                ? ` · ${t("player.downloads.sizeOf", { done: formatFileSize(d.bytes, locale), total: formatFileSize(d.expectedBytes, locale) })}`
                : ""}
            </p>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* Grisé tant qu'il n'y a pas de quoi démarrer — la même règle que la fiche (`offlinePlayable`). */}
        <IconButton
          label={playLabel}
          tone="primary"
          disabled={!playable}
          onClick={() => playable && playback.play({ itemId: d.itemId, title: d.title, resumeAt: d.watchedToEnd ? 0 : d.positionSeconds, offline: { id: d.id } })}
        >
          <Play size={14} fill="currentColor" />
        </IconButton>
        {onOpenTitle && !episode && d.radarrId !== null && (
          <IconButton label={t("player.downloads.open")} onClick={() => onOpenTitle({ type: "movie", id: d.radarrId! })}>
            <Film size={15} />
          </IconButton>
        )}
        {/* La pause (Louis, 19/10/2026) : plus rien n'arrive sur l'appareil, la préparation continue. */}
        {!done && !failed && (
          <IconButton
            label={d.state === "paused" ? t("player.downloads.resumeDownload") : t("player.downloads.pause")}
            onClick={() => void (d.state === "paused" ? resumeOfflineDownload(d.id) : pauseOfflineDownload(d.id))}
          >
            {d.state === "paused" ? <Download size={15} /> : <Pause size={15} />}
          </IconButton>
        )}
        <IconButton label={removeLabel} tone="danger" onClick={() => setConfirming(true)}>
          <Trash2 size={15} />
        </IconButton>
      </div>
      {/* Toujours une confirmation : un film retéléchargé, c'est des centaines de Mo (Louis, 19/10/2026). */}
      <ActionSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        centerOnWide
        title={d.title}
        subtitle={t("player.downloads.confirmRemove")}
        poster={poster}
        actions={[
          { label: removeLabel, icon: <Trash2 size={18} />, variant: "danger", onClick: () => void removeOfflineDownload(d.id) },
          { label: t("common.cancel"), icon: <X size={18} />, onClick: () => {} },
        ]}
      />
    </li>
  );
}

/** L'affiche gardée sur l'appareil — la liste s'affiche aussi sans réseau. */
function usePosterUrl(d: OfflineDownload | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const id = d?.id ?? null;
  const hasPoster = d?.hasPoster ?? false;
  useEffect(() => {
    const account = offlineAccount();
    if (!id || !hasPoster || !account) return;
    let made: string | null = null;
    let cancelled = false;
    void deviceStore
      .readPoster(account, id)
      .then((blob) => {
        if (cancelled || !blob) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, hasPoster]);
  return url;
}

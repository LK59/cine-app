"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, Download, Film, HardDrive, Pause, Play, Trash2, Tv, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { formatDurationShort, formatFileSize, formatMinutes } from "@/lib/format";
import { deviceStore } from "@/lib/offline/deviceStore";
import { offlineAccount, pauseOfflineDownload, removeOfflineDownload, resumeOfflineDownload, useOfflineDownloads, type OfflineDownload } from "@/lib/offline/downloads";
import { groupOfflineDownloads, offlineRemainingSeconds, offlineSeriesNext, type OfflineSeriesGroup } from "@/lib/offline/downloadGroups";
import { BACKDROP_FILE, LOGO_FILE, SERIES_POSTER_FILE, offlineImage } from "@/lib/offline/artwork";
import { BetaBadge, offlinePlayable, offlineProgress, offlineStatusLabel } from "./OfflineDownloadControl";

/**
 * La page des téléchargements (bêta, DECISIONS.md §109) — le contenu seul, monté par deux cadres :
 * le panneau du cinéma (`PlayerDownloadsPanel`, `#telechargements=1`) et l'entrée hors ligne
 * (`/hors-ligne`), servie par le service worker quand le serveur ne répond pas. Un seul dessin pour
 * les deux, pour que la page qu'on retrouve sans réseau soit celle qu'on connaît (Louis, 19/10/2026 :
 * « garde la page partagée »).
 *
 * Deux usages, une page : le gestionnaire (ce qui arrive, la place, la pause, la suppression) et le
 * cinéma sans réseau (ce qu'on peut regarder). D'où, de haut en bas : la place ; « En cours », des
 * lignes avec leurs commandes, tant que quelque chose arrive ; puis les films et les séries en grille
 * d'affiches, comme l'accueil — une affiche ouvre la fiche hors ligne (`OfflineTitleSheet`), où sont
 * Lire, la pause et la suppression.
 *
 * Tout ce qui s'y lit vient de l'appareil — la liste, les affiches, les fiches, la place —, rien du
 * serveur. « Ouvrir la fiche » (la fiche en ligne) n'existe que dans le cinéma (`onOpenTitle`).
 */

export interface OfflineOpenTarget {
  type: "movie" | "series";
  id: number;
}

export function OfflineDownloadsView({ onOpenTitle }: { onOpenTitle?: (target: OfflineOpenTarget) => void }) {
  const t = useT();
  const downloads = useOfflineDownloads();
  const { films, series } = groupOfflineDownloads(downloads);
  // Ce qui arrive encore, le plus récent d'abord : la partie « gestionnaire » de la page.
  const active = downloads.filter((d) => d.state !== "done").sort((a, b) => b.createdAt - a.createdAt);
  // La fiche ouverte : un film (son identifiant) ou une série (sa clé de groupe). Relue dans la liste
  // vivante : elle suit le téléchargement, et se ferme si ce qu'elle montrait a quitté l'appareil.
  const [shown, setShown] = useState<{ film: string } | { series: string } | null>(null);
  const shownFilm = shown && "film" in shown ? films.find((d) => d.id === shown.film) : undefined;
  const shownSeries = shown && "series" in shown ? series.find((g) => g.key === shown.series) : undefined;
  return (
    <div className="space-y-9 [@media(max-height:500px)]:space-y-6">
      {(shownFilm || shownSeries) && <OfflineTitleSheet film={shownFilm} series={shownSeries} onClose={() => setShown(null)} onOpenTitle={onOpenTitle} />}
      <StorageSummary downloads={downloads} />
      {downloads.length === 0 ? (
        <p className="rounded-2xl bg-white/4 px-5 py-10 text-center text-sm text-muted ring-1 ring-inset ring-white/8">{t("player.downloads.empty")}</p>
      ) : (
        <>
          {active.length > 0 && (
            <Section icon={Download} title={t("player.downloads.inProgress")}>
              <ul className="rounded-2xl bg-white/4 px-3 ring-1 ring-inset ring-white/8 sm:px-4">
                {active.map((d) => (
                  <DownloadRow key={d.id} download={d} />
                ))}
              </ul>
            </Section>
          )}
          {films.length > 0 && (
            <Section icon={Film} title={t("player.downloads.films")}>
              <Grid>
                {films.map((d) => (
                  <FilmCard key={d.id} download={d} onShow={() => setShown({ film: d.id })} />
                ))}
              </Grid>
            </Section>
          )}
          {series.length > 0 && (
            <Section icon={Tv} title={t("player.downloads.series")}>
              <Grid>
                {series.map((g) => (
                  <SeriesCard key={g.key} group={g} onShow={() => setShown({ series: g.key })} />
                ))}
              </Grid>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/** Le titre en petites capitales au-dessus d'un bloc — la forme des groupes du Compte. */
function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2.5 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-subtle">
        <Icon size={13} aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <ul className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5">{children}</ul>;
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

/**
 * Une affiche de la grille : l'image gardée, et par-dessus ce qui compte avant de partir — une barre
 * tant que ça arrive, une pause, un échec. Le titre et une ligne dessous, comme les cartes de l'accueil.
 */
function PosterCard({
  url,
  title,
  caption,
  progress,
  paused = false,
  failed = false,
  onShow,
}: {
  url: string | null;
  title: string;
  caption: string;
  /** 0 à 100 tant que le téléchargement n'est pas fini ; absent une fois là. */
  progress?: number;
  paused?: boolean;
  failed?: boolean;
  onShow: () => void;
}) {
  return (
    <li>
      <button type="button" data-nav-item onClick={onShow} aria-label={title} className="group block w-full text-left">
        <span className="relative block aspect-[2/3] overflow-hidden rounded-xl bg-white/6 ring-1 ring-inset ring-white/8">
          {url ? (
            // Une adresse `blob:` de l'affiche gardée sur l'appareil : rien à optimiser par le serveur.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center p-2 text-center text-xs text-subtle">{title}</span>
          )}
          {(paused || failed) && (
            <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white">
              {failed ? <AlertTriangle size={13} className="text-warning" /> : <Pause size={12} />}
            </span>
          )}
          {progress !== undefined && !failed && (
            <span className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-black/50" aria-hidden>
              <span className="block h-full rounded-full bg-white" style={{ width: `${Math.max(3, progress)}%` }} />
            </span>
          )}
        </span>
        <span className="mt-1.5 block truncate text-xs font-medium text-white">{title}</span>
        <span className="block truncate text-[11px] text-subtle">{caption}</span>
      </button>
    </li>
  );
}

function FilmCard({ download: d, onShow }: { download: OfflineDownload; onShow: () => void }) {
  const t = useT();
  const poster = usePosterUrl(d);
  const remaining = offlineRemainingSeconds(d);
  const caption =
    d.state !== "done"
      ? offlineStatusLabel(d, t)
      : remaining !== null && !d.watchedToEnd
        ? t("cinema.timeRemaining", { time: formatDurationShort(remaining * 1e7) })
        : [d.year, t(`player.downloads.${d.quality}`)].filter(Boolean).join(" · ");
  return (
    <PosterCard
      url={poster}
      title={d.title}
      caption={caption}
      progress={d.state === "done" ? undefined : offlineProgress(d)}
      paused={d.state === "paused"}
      failed={d.state === "failed"}
      onShow={onShow}
    />
  );
}

function SeriesCard({ group, onShow }: { group: OfflineSeriesGroup; onShow: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const episodes = group.seasons.flatMap((s) => s.episodes);
  // L'affiche de la série, gardée avec un de ses épisodes ; à défaut, la vignette du premier.
  const holder = episodes.find((d) => d.artwork?.hasSeriesPoster);
  const seriesPoster = useOfflineImage(holder, SERIES_POSTER_FILE, holder?.artwork?.hasSeriesPoster);
  const firstPoster = usePosterUrl(holder ? null : group.first);
  const arriving = episodes.filter((d) => d.state !== "done" && d.state !== "failed");
  const progress = arriving.length ? Math.floor(arriving.reduce((sum, d) => sum + offlineProgress(d), 0) / arriving.length) : undefined;
  return (
    <PosterCard
      url={seriesPoster ?? firstPoster}
      title={group.title}
      caption={`${t("player.downloads.episodes", { n: episodes.length })} · ${formatFileSize(group.bytes, locale)}`}
      progress={progress}
      failed={episodes.every((d) => d.state === "failed")}
      onShow={onShow}
    />
  );
}

function Poster({ url }: { url: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="h-[4.5rem] w-12 shrink-0 rounded-lg object-cover" />
  ) : (
    <span className="flex h-[4.5rem] w-12 shrink-0 items-center justify-center rounded-lg bg-white/8 text-subtle">
      <Film size={16} aria-hidden />
    </span>
  );
}

/** La vignette d'un épisode, au format de l'image. */
function Thumbnail({ url }: { url: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="aspect-video w-28 shrink-0 rounded-lg object-cover sm:w-36" />
  ) : (
    <span className="flex aspect-video w-28 shrink-0 items-center justify-center rounded-lg bg-white/8 text-subtle sm:w-36">
      <Tv size={16} aria-hidden />
    </span>
  );
}

function IconButton({
  label,
  onClick,
  tone = "ghost",
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: "ghost" | "danger";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-nav-item
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone === "danger" ? "bg-white/8 text-danger" : "bg-white/8 text-white"}`}
    >
      {children}
    </button>
  );
}

/** Un bouton qui dit ce qu'il fait : l'icône et le mot. */
function PillButton({
  label,
  text,
  icon,
  onClick,
  disabled = false,
  tone = "ghost",
}: {
  label: string;
  text: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "primary" | "ghost" | "danger";
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
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-opacity ${colors} ${disabled ? "cursor-default opacity-35" : ""}`}
    >
      {icon}
      {text}
    </button>
  );
}

/** Lancer un téléchargement : à sa position gardée, du début s'il a été vu jusqu'au bout. */
function usePlayDownload() {
  const playback = usePlayback();
  return (d: OfflineDownload) => playback.play({ itemId: d.itemId, title: d.title, resumeAt: d.watchedToEnd ? 0 : d.positionSeconds, offline: { id: d.id } });
}

/**
 * Supprimer, toujours confirmé : un film retéléchargé, c'est des centaines de Mo (Louis, 19/10/2026).
 * Rend le geste qui ouvre la confirmation, et la confirmation à monter.
 */
function useRemoval(d: OfflineDownload, poster: string | null): { label: string; ask: () => void; sheet: React.ReactNode } {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const label = d.state === "done" || d.state === "failed" ? t("player.downloads.remove") : t("player.downloads.cancel");
  const sheet = (
    <ActionSheet
      open={confirming}
      onClose={() => setConfirming(false)}
      role="alertdialog"
      centerOnWide
      title={d.title}
      subtitle={t("player.downloads.confirmRemove")}
      poster={poster}
      actions={[
        { label, icon: <Trash2 size={18} />, variant: "danger", onClick: () => void removeOfflineDownload(d.id) },
        { label: t("common.cancel"), icon: <X size={18} />, onClick: () => {} },
      ]}
    />
  );
  return { label, ask: () => setConfirming(true), sheet };
}

/** Pause ou reprise d'un téléchargement qui arrive — la préparation du serveur, elle, continue. */
function PauseButton({ download: d }: { download: OfflineDownload }) {
  const t = useT();
  if (d.state === "done" || d.state === "failed") return null;
  const paused = d.state === "paused";
  return (
    <PillButton
      label={paused ? t("player.downloads.resumeDownload") : t("player.downloads.pause")}
      text={paused ? t("player.downloads.resumeShort") : t("player.downloads.pauseShort")}
      icon={paused ? <Download size={14} /> : <Pause size={14} />}
      onClick={() => void (paused ? resumeOfflineDownload(d.id) : pauseOfflineDownload(d.id))}
    />
  );
}

/** L'avancement d'un téléchargement : la barre, l'état à gauche, les tailles à droite. */
function ProgressBlock({ download: d }: { download: OfflineDownload }) {
  const t = useT();
  const { locale } = useLocale();
  const pct = offlineProgress(d);
  if (d.state === "failed") {
    return (
      <p className="mt-0.5 truncate text-xs text-warning">
        {offlineStatusLabel(d, t)}
        {d.error ? ` · ${d.error}` : ""}
      </p>
    );
  }
  return (
    <div className="mt-1.5">
      <div className="h-1 overflow-hidden rounded-full bg-white/12" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={offlineStatusLabel(d, t)}>
        <div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${d.bytes > 0 ? Math.max(2, pct) : 0}%` }} />
      </div>
      <p className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-subtle">
        <span className="truncate">{offlineStatusLabel(d, t)}</span>
        {d.expectedBytes > 0 && d.bytes > 0 && (
          <span className="shrink-0 tabular-nums">{t("player.downloads.sizeOf", { done: formatFileSize(d.bytes, locale), total: formatFileSize(d.expectedBytes, locale) })}</span>
        )}
      </p>
    </div>
  );
}

/**
 * Une ligne avec ses commandes : un téléchargement qui arrive (« En cours »), ou un épisode dans la
 * fiche de sa série (`rich` : sa vignette et son résumé). « Lire » et « Pause » écrits en toutes
 * lettres (Louis, 19/10/2026) : une icône de lecture seule se confondait avec la reprise du
 * téléchargement. Au téléphone, les boutons sous le texte — à côté de trois ronds, la langue et
 * l'avancement étaient coupés.
 */
function DownloadRow({ download: d, rich = false }: { download: OfflineDownload; rich?: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const play = usePlayDownload();
  const poster = usePosterUrl(d);
  const removal = useRemoval(d, poster);
  const done = d.state === "done";
  const playable = offlinePlayable(d);
  const remaining = offlineRemainingSeconds(d);
  const title = rich && d.episode ? `${d.episode.episodeNumber ?? "–"}. ${d.episode.episodeTitle || d.title}` : d.title;
  const runtime = d.runtimeSeconds ? formatMinutes(Math.round(d.runtimeSeconds / 60)) : null;
  return (
    <li className="flex flex-col gap-2.5 border-t border-white/8 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-3">
      <div className={`flex min-w-0 flex-1 gap-3 ${rich ? "items-start" : "items-center"}`}>
        {rich ? <Thumbnail url={poster} /> : <Poster url={poster} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{title}</p>
          {rich ? (
            <p className="truncate text-xs text-subtle">
              {d.watchedToEnd
                ? t("player.downloads.watched")
                : remaining !== null
                  ? t("cinema.timeRemaining", { time: formatDurationShort(remaining * 1e7) })
                  : runtime}
              {done ? <> · {formatFileSize(d.bytes, locale)}</> : null}
            </p>
          ) : (
            <p className="truncate text-xs text-subtle">
              {t(`player.downloads.${d.quality}`)} · {d.audioLabel}
            </p>
          )}
          {!done && <ProgressBlock download={d} />}
          {rich && d.artwork?.overview && <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted">{d.artwork.overview}</p>}
        </div>
      </div>
      <div className={`flex shrink-0 items-center gap-1.5 ${rich ? "" : "pl-[3.75rem]"} sm:pl-0`}>
        {/* Grisé tant qu'il n'y a pas de quoi démarrer — la même règle que la fiche (`offlinePlayable`). */}
        <PillButton
          label={t(done ? "player.downloads.playDownloaded" : "player.downloads.playDownloading")}
          text={t("common.play")}
          icon={<Play size={13} fill="currentColor" />}
          tone="primary"
          disabled={!playable}
          onClick={() => playable && play(d)}
        />
        <PauseButton download={d} />
        <IconButton label={removal.label} tone="danger" onClick={removal.ask}>
          <Trash2 size={15} />
        </IconButton>
      </div>
      {removal.sheet}
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

/** Une image gardée avec un téléchargement (logo, visuel, affiche de série), en adresse `blob:` partagée. */
function useOfflineImage(d: OfflineDownload | undefined, name: string, has: boolean | undefined): string | null {
  const [url, setUrl] = useState<{ key: string; url: string | null } | null>(null);
  const id = d?.id ?? null;
  const key = `${id}/${name}`;
  useEffect(() => {
    const account = offlineAccount();
    if (!id || !has || !account) return;
    let cancelled = false;
    void offlineImage(account, id, name).then((made) => {
      if (!cancelled) setUrl({ key, url: made });
    });
    return () => {
      cancelled = true;
    };
  }, [id, name, has, key]);
  return url?.key === key ? url.url : null;
}

/** Sous « Lire » dans la fiche d'un film : pause, suppression, et la fiche en ligne dans le cinéma. */
function FilmActions({ film, poster, openOnline }: { film: OfflineDownload; poster: string | null; openOnline?: (target: OfflineOpenTarget) => void }) {
  const t = useT();
  const removal = useRemoval(film, poster);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <PauseButton download={film} />
      <PillButton label={removal.label} text={removal.label} icon={<Trash2 size={14} />} tone="danger" onClick={removal.ask} />
      {openOnline && film.radarrId !== null && (
        <PillButton label={t("player.downloads.open")} text={t("player.downloads.openShort")} icon={<Film size={14} />} onClick={() => openOnline({ type: "movie", id: film.radarrId! })} />
      )}
      {removal.sheet}
    </div>
  );
}

/**
 * La fiche hors ligne d'un film ou d'une série (Louis, 19/10/2026 : « pas de fiche série en full hors
 * ligne ? juste les épisodes bruts ? ») : la forme d'une fiche du cinéma — grand visuel, logo, année et
 * genres, Lire en tête, résumé, distribution — faite de ce qui est gardé avec le téléchargement
 * (`artwork.ts`). La distribution en texte seul, sans liens ni photos : une fiche de personne ne
 * s'ouvre pas sans réseau, et ses images alourdiraient chaque téléchargement. Pour une série, ses
 * épisodes sur l'appareil, saison par saison, avec leur vignette et leur résumé.
 *
 * Un calque au-dessus de la page, sous le lecteur (z 50 contre 80) et sous les confirmations (60).
 */
function OfflineTitleSheet({
  film,
  series,
  onClose,
  onOpenTitle,
}: {
  film?: OfflineDownload;
  series?: OfflineSeriesGroup;
  onClose: () => void;
  onOpenTitle?: (target: OfflineOpenTarget) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const play = usePlayDownload();
  const episodes = series ? series.seasons.flatMap((s) => s.episodes) : [];
  // Ce que la série garde de sa fiche : chez l'épisode le plus récemment demandé qui en a une.
  const lead = film ?? [...episodes].sort((a, b) => b.createdAt - a.createdAt).find((d) => d.artwork) ?? series?.first;
  const artwork = lead?.artwork ?? null;
  const backdrop = useOfflineImage(lead, BACKDROP_FILE, artwork?.hasBackdrop);
  const logo = useOfflineImage(lead, LOGO_FILE, artwork?.hasLogo);
  const poster = usePosterUrl(film ?? null);
  const facts = film ? artwork : (artwork?.series ?? null);
  const name = film ? film.title : (series?.title ?? "");
  const runtime = film?.runtimeSeconds ? formatMinutes(Math.round(film.runtimeSeconds / 60)) : null;
  const meta = [facts?.year ?? film?.year ?? null, runtime, ...(facts?.genres ?? []).slice(0, 3)].filter(Boolean).join(" · ");
  // Lire en tête : le film, ou l'épisode à reprendre / le suivant à voir parmi ceux de l'appareil.
  const next = film ?? (series ? offlineSeriesNext(series) : null);
  // La fiche en ligne passe par-dessus la page : celle-ci se ferme d'abord, elle la couvrirait.
  const openOnline = onOpenTitle ? (target: OfflineOpenTarget) => (onClose(), onOpenTitle(target)) : undefined;

  useEffect(() => {
    // En capture, et arrêtée : la page qui la porte se ferme aussi sur Échap, et un appui ne doit
    // refermer qu'un écran à la fois.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  const resume = next ? offlineRemainingSeconds(next) : null;
  const nextCode = next?.episode && next.episode.episodeNumber !== null ? t("cinema.episodeShort", { episode: next.episode.episodeNumber, season: next.episode.seasonNumber }) : null;
  const playMain = [t(resume !== null && !next?.watchedToEnd ? "common.resume" : "common.play"), nextCode].filter(Boolean).join(" ");
  const playDetail = next
    ? next.state !== "done"
      ? // Un film a sa barre juste dessous ; un épisode, non : son état ici.
        film
        ? t("player.downloads.fileDownloading")
        : offlineStatusLabel(next, t)
      : resume !== null && !next.watchedToEnd
        ? t("cinema.timeRemaining", { time: formatDurationShort(resume * 1e7) })
        : t("player.downloads.fileDownloaded")
    : null;
  const ready = next ? offlinePlayable(next) : false;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={name} className="fixed inset-0 z-50 animate-fade-in overflow-y-auto overscroll-contain bg-ink">
      <div className="relative">
        <div className="relative aspect-video max-h-[62vh] w-full overflow-hidden bg-white/4">
          {(backdrop ?? poster) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={(backdrop ?? poster)!} alt="" className={`h-full w-full object-cover ${backdrop ? "" : "scale-110 blur-2xl"}`} />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/30 to-transparent" />
        </div>
        <button
          type="button"
          data-nav-item
          onClick={onClose}
          aria-label={t("common.back")}
          className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur"
          style={{ top: "max(1rem, env(safe-area-inset-top))" }}
        >
          <ArrowLeft size={18} />
        </button>
      </div>
      <div className="relative mx-auto -mt-20 w-full max-w-3xl px-4 pb-16 sm:-mt-28 sm:px-8">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt={name} className="mb-4 max-h-24 max-w-[70%] object-contain object-left sm:max-h-32" />
        ) : (
          <h2 className="mb-3 font-display text-3xl font-semibold text-white sm:text-4xl">{name}</h2>
        )}
        <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          {meta && <span>{meta}</span>}
          <BetaBadge />
        </p>

        {next && (
          <div className="mb-5 space-y-2">
            <button
              type="button"
              data-nav-item
              disabled={!ready}
              onClick={() => ready && play(next)}
              className={`flex w-full sm:max-w-sm items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-base font-semibold text-ink ${ready ? "" : "opacity-45"}`}
            >
              <Play size={18} fill="currentColor" />
              <span className="flex min-w-0 flex-col items-start leading-tight">
                <span>{playMain}</span>
                {playDetail && <span className="truncate text-xs font-medium opacity-60">{playDetail}</span>}
              </span>
            </button>
            {film && film.state !== "done" && <ProgressBlock download={film} />}
            {film && <FilmActions film={film} poster={poster} openOnline={openOnline} />}
            {series && openOnline && series.sonarrId !== null && (
              <PillButton label={t("player.downloads.openSeries")} text={t("player.downloads.openShort")} icon={<Tv size={14} />} onClick={() => openOnline({ type: "series", id: series.sonarrId! })} />
            )}
          </div>
        )}

        {film && (
          <p className="mb-3 text-xs text-subtle">
            {t(`player.downloads.${film.quality}`)} · {film.audioLabel}
            {film.state === "done" ? <> · {formatFileSize(film.bytes, locale)}</> : null}
          </p>
        )}
        {facts?.overview && <p className="mb-3 text-sm leading-6 text-muted">{facts.overview}</p>}
        {facts && facts.cast.length > 0 && (
          <p className="mb-6 text-xs leading-5 text-subtle">
            <span className="text-muted">{t("player.downloads.castLabel")}</span> {facts.cast.join(", ")}
          </p>
        )}

        {series?.seasons.map((season) => (
          <section key={season.season} className="mb-5">
            <h3 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-subtle">{t("player.downloads.season", { n: season.season })}</h3>
            <ul className="rounded-2xl bg-white/4 px-3 ring-1 ring-inset ring-white/8 sm:px-4">
              {season.episodes.map((d) => (
                <DownloadRow key={d.id} download={d} rich />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>,
    document.body
  );
}

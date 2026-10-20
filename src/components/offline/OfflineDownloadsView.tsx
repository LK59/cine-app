"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Download, Film, HardDrive, Pause, Play, RotateCcw, Trash2, Tv, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { PlayerResultCard } from "@/components/player/PlayerResultCard";
import { PlayerEmptyState } from "@/components/player/PlayerEmptyState";
import { formatDurationShort, formatFileSize } from "@/lib/format";
import { useIsMobile } from "@/lib/useIsMobile";
import { useExitDelay } from "@/lib/useExitDelay";
import { SHEET_OUT_MS, SHEET_UNMOUNT_SLACK_MS } from "@/lib/sheetMotion";
import { offlineAccount, pauseOfflineDownload, removeOfflineDownload, resumeOfflineDownload, retryOfflineDownload, useOfflineDownloads, type OfflineDownload } from "@/lib/offline/downloads";
import { groupOfflineDownloads, offlineRemainingSeconds, type OfflineSeriesGroup } from "@/lib/offline/downloadGroups";
import { BACKDROP_FILE, LOGO_FILE, POSTER_FILE, SERIES_POSTER_FILE, offlineImage } from "@/lib/offline/artwork";
import { OfflineTitleSheet } from "./OfflineTitleSheet";
import { useOfflineImage } from "./useOfflineImage";
import { offlinePlayable, offlineProgress, offlineStatusLabel, touchDevice } from "./OfflineDownloadControl";

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
  // Gardée le temps de sa sortie, comme les fiches que la coquille du cinéma garde (`sheetExitMs`) :
  // la cible survit à la fermeture, `open` dit si elle est encore demandée.
  const [shown, setShown] = useState<{ film: string } | { series: string } | null>(null);
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const sheet = useExitDelay(open, isMobile ? SHEET_OUT_MS + SHEET_UNMOUNT_SLACK_MS : 200);
  const shownFilm = shown && "film" in shown ? films.find((d) => d.id === shown.film) : undefined;
  const shownSeries = shown && "series" in shown ? series.find((g) => g.key === shown.series) : undefined;
  const show = (target: { film: string } | { series: string }) => {
    const lead = "film" in target ? films.find((d) => d.id === target.film) : seriesLead(series.find((g) => g.key === target.series));
    // Le visuel et le logo décodés avant d'ouvrir, comme les fiches du cinéma (`prefetchTitleSheet`) :
    // ouverte avant, la fiche faisait voler l'affiche agrandie — floue, son titre compris — et son
    // visuel paraissait en fondu en plein vol, devant elle (Louis, 20/10/2026). Ils sont sur l'appareil :
    // un quart de seconde au plus, l'appui reste celui que le trajet reconnaît.
    void decodeArtwork(lead).then(() => {
      setShown(target);
      setOpen(true);
    });
  };
  return (
    <div className="space-y-9 [@media(max-height:500px)]:space-y-6">
      {sheet.render && (shownFilm || shownSeries) && (
        <OfflineTitleSheet
          key={shownFilm?.id ?? shownSeries?.key}
          film={shownFilm}
          series={shownSeries}
          leaving={sheet.leaving || !open}
          onClose={() => setOpen(false)}
          onOpenTitle={onOpenTitle}
        />
      )}
      <StorageSummary downloads={downloads} />
      {downloads.length === 0 ? (
        <PlayerEmptyState icon={Download} message={t("player.downloads.empty")} />
      ) : (
        <>
          {active.length > 0 && (
            <Section icon={Download} title={t("player.downloads.inProgress")}>
              <ul className="rounded-2xl bg-white/4 px-3 ring-1 ring-inset ring-white/8 sm:px-4">
                {active.map((d) => (
                  <DownloadRow key={d.id} download={d} />
                ))}
              </ul>
              {/* Là où l'on regarde l'avancement, tant que quelque chose arrive encore. */}
              {active.some((d) => d.state === "preparing" || d.state === "downloading") && touchDevice() && (
                <p className="mt-2 px-1 text-xs text-subtle">{t("player.downloads.keepOpen")}</p>
              )}
            </Section>
          )}
          {films.length > 0 && (
            <Section icon={Film} title={t("player.downloads.films")}>
              <Grid>
                {films.map((d) => (
                  <FilmCard key={d.id} download={d} onShow={() => show({ film: d.id })} />
                ))}
              </Grid>
            </Section>
          )}
          {series.length > 0 && (
            <Section icon={Tv} title={t("player.downloads.series")}>
              <Grid>
                {series.map((g) => (
                  <SeriesCard key={g.key} group={g} onShow={() => show({ series: g.key })} />
                ))}
              </Grid>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/** Ce qu'une série garde de sa fiche : chez l'épisode le plus récemment demandé qui en a une (la règle de `OfflineTitleSheet`). */
function seriesLead(group: OfflineSeriesGroup | undefined): OfflineDownload | undefined {
  if (!group) return undefined;
  const episodes = group.seasons.flatMap((s) => s.episodes);
  return [...episodes].sort((a, b) => b.createdAt - a.createdAt).find((d) => d.artwork) ?? group.first;
}

async function decodeArtwork(d: OfflineDownload | undefined): Promise<void> {
  const account = offlineAccount();
  if (!d?.artwork || !account) return;
  const names = [d.artwork.hasBackdrop ? BACKDROP_FILE : null, d.artwork.hasLogo ? LOGO_FILE : null].filter((n): n is string => n !== null);
  const decode = async (name: string) => {
    const url = await offlineImage(account, d.id, name);
    if (!url) return;
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
  };
  await Promise.race([Promise.all(names.map(decode)), new Promise((r) => setTimeout(r, 250))]);
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
  // La grille de Ma liste (`PlayerListPanel`), à l'identique.
  return <ul className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5">{children}</ul>;
}

/**
 * La place sur l'appareil : ce que prennent les téléchargements de ce compte, et ce que le
 * navigateur dit pouvoir encore accorder à l'application (`navigator.storage.estimate`). Ce n'est pas
 * la place libre du disque, et le libellé le dit (« autorisés par le navigateur ») : Chrome, Edge et
 * Firefox sous Windows annonçaient tous « usage + 10 Gio » pile (startup.log, 09-10/2026) quand Safari
 * sur iPhone donnait ~41 Go — « environ 10 Go encore disponibles » se lisait comme le disque du PC.
 */
/**
 * La dernière place libre lue, gardée pour la prochaine ouverture (20/10/2026) : l'estimation arrive
 * après le premier rendu, et la barre qu'elle fait apparaître poussait toute la page de 18 px à
 * chaque ouverture. La page s'ouvre avec la valeur d'avant, que la nouvelle remplace.
 */
let lastFree: number | null = null;

function StorageSummary({ downloads }: { downloads: OfflineDownload[] }) {
  const t = useT();
  const { locale } = useLocale();
  const used = downloads.reduce((sum, d) => sum + d.bytes, 0);
  const [free, setFree] = useState<number | null>(lastFree);
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
        if (cancelled || typeof e.quota !== "number" || typeof e.usage !== "number") return;
        lastFree = Math.max(0, e.quota - e.usage);
        setFree(lastFree);
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
 * Une affiche de la grille : la carte de Ma liste et de la recherche (`PlayerResultCard`) — même
 * cadre, même appui, même fondu, même titre —, et par-dessus ce qui compte avant de partir : une barre
 * tant que ça arrive, une pause, un échec.
 */
function PosterCard({
  kind,
  url,
  title,
  caption,
  progress,
  paused = false,
  failed = false,
  onShow,
}: {
  kind: "movie" | "series";
  url: string | null;
  title: string;
  caption: string;
  /** 0 à 100 tant que le téléchargement n'est pas fini ; absent une fois là. */
  progress?: number;
  paused?: boolean;
  failed?: boolean;
  onShow: () => void;
}) {
  const overlay = (
    <>
      {(paused || failed) && (
        <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white">
          {failed ? <AlertTriangle size={13} className="text-warning" /> : <Pause size={12} />}
        </span>
      )}
      {progress !== undefined && !failed && (
        <span className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-black/50" aria-hidden>
          <span className="block h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${Math.max(3, progress)}%` }} />
        </span>
      )}
    </>
  );
  return (
    // `grid` : la carte (un bouton) prend toute la largeur de sa case, comme dans Ma liste où elle est
    // l'enfant direct de la grille — sinon chaque affiche avait la largeur de son image.
    // Sans fondu à elle : l'écran entier arrive déjà en fondu, et les deux opacités se multipliaient —
    // le contenu se posait visiblement après le cadre (20/10/2026).
    <li className="grid">
      <PlayerResultCard kind={kind} showKind={false} title={title} subtitle={caption} poster={url} onOpen={onShow} overlay={overlay} />
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
      kind="movie"
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
      kind="series"
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

/** L'anneau de focus des cartes et des boutons de l'app (clavier, télécommande). */
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500";

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
      className={`pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${FOCUS} ${tone === "danger" ? "bg-white/8 text-danger" : "bg-white/8 text-white"}`}
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
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-opacity ${FOCUS} ${colors} ${disabled ? "cursor-default opacity-35" : "pressable"}`}
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
 * Une ligne de « En cours », avec ses commandes. « Lire » et « Pause » écrits en toutes lettres (Louis,
 * 19/10/2026) : une icône de lecture seule se confondait avec la reprise du téléchargement. Au
 * téléphone, les boutons sous le texte — à côté de trois ronds, la langue et l'avancement étaient coupés.
 */
function DownloadRow({ download: d }: { download: OfflineDownload }) {
  const t = useT();
  const play = usePlayDownload();
  const poster = usePosterUrl(d);
  const removal = useRemoval(d, poster);
  const done = d.state === "done";
  const playable = offlinePlayable(d);
  return (
    <li className="flex flex-col gap-2.5 border-t border-white/8 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Poster url={poster} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{d.title}</p>
          <p className="truncate text-xs text-subtle">
            {t(`player.downloads.${d.quality}`)} · {d.audioLabel}
          </p>
          {!done && <ProgressBlock download={d} />}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pl-[3.75rem] sm:pl-0">
        {/* Un échec se réessaie aux mêmes choix ; sinon Lire, grisé tant qu'il n'y a pas de quoi
            démarrer — la même règle que la fiche (`offlinePlayable`). */}
        {d.state === "failed" ? (
          <PillButton label={t("player.downloads.retry")} text={t("player.downloads.retry")} icon={<RotateCcw size={14} />} tone="primary" onClick={() => void retryOfflineDownload(d.id)} />
        ) : (
          <PillButton
            label={t(done ? "player.downloads.playDownloaded" : "player.downloads.playDownloading")}
            text={t("common.play")}
            icon={<Play size={13} fill="currentColor" />}
            tone="primary"
            disabled={!playable}
            onClick={() => playable && play(d)}
          />
        )}
        <PauseButton download={d} />
        <IconButton label={removal.label} tone="danger" onClick={removal.ask}>
          <Trash2 size={15} />
        </IconButton>
      </div>
      {removal.sheet}
    </li>
  );
}

/** L'affiche gardée sur l'appareil, en adresse partagée (`useOfflineImage`) — la liste s'affiche aussi sans réseau. */
function usePosterUrl(d: OfflineDownload | null): string | null {
  return useOfflineImage(d, POSTER_FILE, d?.hasPoster);
}

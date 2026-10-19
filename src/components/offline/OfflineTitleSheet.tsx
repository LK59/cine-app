"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, Download, Film, Pause, Play, RotateCcw, Trash2, Tv, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { FadeInImg } from "@/components/FadeInImg";
import { PosterImage } from "@/components/PosterImage";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { CinemaDetailPages, CinemaDetailTitle, PhoneSheetTitle } from "@/components/cinema/CinemaDetailPages";
import { CinemaOverview, COLUMN_GAP, COLUMN_STYLE, HORIZONTAL_VEIL, MENU_STYLE, VERTICAL_VEIL } from "@/components/cinema/CinemaDetailLayout";
import { CinemaEpisodeProgress } from "@/components/cinema/CinemaEpisodeProgress";
import { MENU_BADGE, MENU_ROW, MENU_ROW_INACTIVE, detailMenuArrowNav, focusFirstAction } from "@/components/cinema/detailMenu";
import { formatDurationShort, formatFileSize, formatMinutes } from "@/lib/format";
import { genreLabel } from "@/lib/top10Label";
import { liquidButtonRef } from "@/lib/liquidGlass/liquid";
import { useLiquidDelegation } from "@/lib/liquidGlass/useLiquidDelegation";
import { useIsMobile, useIsShortViewport } from "@/lib/useIsMobile";
import { useSwipeToDismiss, NOT_THE_HANDLE } from "@/lib/useSwipeToDismiss";
import { useSheetExit } from "@/lib/useSheetExit";
import { useSheetTransition } from "@/lib/sheetMorph/desktopContinuity";
import { detailColumnMotion, phoneSheetCorner, phoneSheetShadow, sheetMotionClass } from "@/lib/sheetMotion";
import { pauseOfflineDownload, removeOfflineDownload, resumeOfflineDownload, retryOfflineDownload, type OfflineDownload } from "@/lib/offline/downloads";
import { offlineRemainingSeconds, offlineSeriesNext, type OfflineSeriesGroup } from "@/lib/offline/downloadGroups";
import { BACKDROP_FILE, LOGO_FILE, POSTER_FILE } from "@/lib/offline/artwork";
import { BetaBadge, OfflinePlayButton, offlinePlayable, offlineProgress, offlineStatusLabel } from "./OfflineDownloadControl";
import { DownloadStateButton } from "./OfflineEpisodeDownload";
import { useOfflineImage } from "./useOfflineImage";
import type { OfflineOpenTarget } from "./OfflineDownloadsView";

/**
 * La fiche hors ligne d'un film ou d'une série (Louis, 19/10/2026 : « pas de fiche série en full hors
 * ligne ? », puis « aligner le design sur l'app standard ») : **les fiches du cinéma, à l'identique**,
 * faites de ce que l'appareil garde avec le téléchargement (`artwork.ts`) et de rien d'autre.
 *
 * - Le cadre et le mouvement des fiches de la bibliothèque, pièce pour pièce : la carte du téléphone
 *   (`phone-sheet-frame`, bannière qu'on tire vers le bas, croix en verre) et l'écran plein du bureau
 *   (visuel, voiles, « Retour », colonne en bas, deux pages) ; l'affiche touchée qui devient la fiche
 *   et la fiche qui y retourne (`useSheetTransition`, DECISIONS.md §61) — la carte de la grille est un
 *   bouton qui porte une image, elle est donc une source comme une autre ; Échap et Retour arrière
 *   (`useSheetExit`) ; les flèches dans le menu au bureau.
 * - Ce qui n'y est pas, exprès : rien qui demande au serveur (ni SWR, ni route, ni optimiseur
 *   d'images — la page s'ouvre sans réseau) ; la distribution en texte seul, sans liens ni photos ;
 *   pas d'adresse (`cinemaRoute`) — la fiche vit dans l'état de la page, qui est aussi `/hors-ligne`.
 *
 * Montée par la page, qui la garde le temps de sa sortie (`leaving`, `useExitDelay`).
 */
export function OfflineTitleSheet({
  film,
  series,
  leaving,
  onClose,
  onOpenTitle,
}: {
  film?: OfflineDownload;
  series?: OfflineSeriesGroup;
  leaving: boolean;
  onClose: () => void;
  onOpenTitle?: (target: OfflineOpenTarget) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const isMobile = useIsMobile();
  const short = useIsShortViewport();
  const rootRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const episodes = series ? series.seasons.flatMap((s) => s.episodes) : [];
  // Ce que la série garde de sa fiche : chez l'épisode le plus récemment demandé qui en a une.
  const lead = film ?? [...episodes].sort((a, b) => b.createdAt - a.createdAt).find((d) => d.artwork) ?? series?.first;
  const artwork = lead?.artwork ?? null;
  const backdrop = useOfflineImage(lead, BACKDROP_FILE, artwork?.hasBackdrop);
  const logo = useOfflineImage(lead, LOGO_FILE, artwork?.hasLogo);
  const poster = useOfflineImage(film, POSTER_FILE, film?.hasPoster);
  const facts = film ? artwork : (artwork?.series ?? null);
  const name = film ? film.title : (series?.title ?? "");
  const runtime = film?.runtimeSeconds ? formatMinutes(Math.round(film.runtimeSeconds / 60)) : null;
  const year = facts?.year ?? film?.year ?? null;
  const genres = (facts?.genres ?? []).slice(0, 3).map((g) => genreLabel(g, t));
  // Lire en tête : le film, ou l'épisode commencé / le premier pas vu parmi ceux de l'appareil.
  const next = film ?? (series ? offlineSeriesNext(series) : null);
  const nextCode =
    next?.episode && next.episode.episodeNumber !== null ? t("cinema.episodeShort", { episode: next.episode.episodeNumber, season: next.episode.seasonNumber }) : null;
  // La fiche en ligne passe par-dessus la page : celle-ci se ferme d'abord, elle la couvrirait.
  const openOnline = onOpenTitle ? (target: OfflineOpenTarget) => (onClose(), onOpenTitle(target)) : undefined;
  const onlineTarget: OfflineOpenTarget | null =
    film && film.radarrId !== null ? { type: "movie", id: film.radarrId } : series && series.sonarrId !== null ? { type: "series", id: series.sonarrId } : null;

  const exit = useSheetExit(onClose, { leaving, listening: !overviewOpen && !confirming });
  const swipe = useSwipeToDismiss(exit.requestClose);
  useLiquidDelegation(rootRef);
  const morph = useSheetTransition({
    layout: isMobile ? "phone" : "desktop",
    rootRef,
    imageRef: isMobile ? bannerRef : rootRef,
    active: true,
    leaving,
    revealed: false,
  });

  // Au bureau : le focus sur la première action, et les flèches dans le menu, comme les fiches.
  useEffect(() => {
    if (!isMobile) focusFirstAction(rootRef.current);
  }, [isMobile]);
  useEffect(() => {
    if (isMobile || leaving || overviewOpen || confirming) return;
    const onKey = (e: KeyboardEvent) => void detailMenuArrowNav(e, rootRef.current);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, leaving, overviewOpen, confirming]);

  if (typeof document === "undefined") return null;

  const removeLabel = film ? t(film.state === "done" || film.state === "failed" ? "player.downloads.remove" : "player.downloads.cancel") : "";
  const paused = film?.state === "paused";
  const arriving = film && film.state !== "done" && film.state !== "failed";
  const removal = film && (
    <ActionSheet
      open={confirming}
      onClose={() => setConfirming(false)}
      role="alertdialog"
      centerOnWide
      title={film.title}
      subtitle={t("player.downloads.confirmRemove")}
      poster={poster}
      actions={[
        { label: removeLabel, icon: <Trash2 size={18} />, variant: "danger", noAutoFocus: true, onClick: () => void removeOfflineDownload(film.id) },
        { label: t("common.cancel"), icon: <X size={18} />, onClick: () => {} },
      ]}
    />
  );
  const overviewSheet = facts?.overview && (
    <ActionSheet open={overviewOpen} onClose={() => setOverviewOpen(false)} centerOnWide title={name} actions={[{ label: t("player.downloads.close"), icon: <X size={18} />, onClick: () => {} }]}>
      <p className="max-h-[50vh] overflow-y-auto px-5 py-4 text-sm leading-6 text-white">{facts.overview}</p>
    </ActionSheet>
  );
  const cast = facts && facts.cast.length > 0 && (
    <p className="text-xs leading-5 text-subtle">
      <span className="text-muted">{t("player.downloads.castLabel")}</span> {facts.cast.join(", ")}
    </p>
  );
  const metaItems = [year, runtime, ...genres].filter(Boolean) as (string | number)[];
  const episodeList = series && morph.settled && (
    <div className={isMobile ? "mt-2" : "mx-auto w-full max-w-3xl px-6 pb-16 pt-6 sm:px-10"}>
      {series.seasons.map((season) => (
        <section key={season.season} className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-white">{t("player.downloads.season", { n: season.season })}</h3>
          <div className="flex flex-col gap-1">
            {season.episodes.map((d) => (
              <EpisodeRow key={d.id} download={d} size={isMobile ? "phone" : "desktop"} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );

  if (isMobile) {
    return createPortal(
      <>
        <div
          ref={rootRef}
          role="dialog"
          aria-modal="true"
          aria-label={name}
          className={`phone-sheet-frame safe-x fixed inset-x-0 overflow-y-auto overscroll-contain bg-ink ring-1 ring-white/10 ${sheetMotionClass({
            swipe,
            leaving,
            revealed: morph.handlesEntry,
            out: "",
          })}`}
          style={{
            zIndex: 48,
            ...exit.style,
            transform: swipe.touched ? `translateY(${swipe.offset}px)` : undefined,
            transition: swipe.dragging ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 200ms ease-out",
            borderTopLeftRadius: phoneSheetCorner(swipe.offset),
            borderTopRightRadius: phoneSheetCorner(swipe.offset),
            boxShadow: phoneSheetShadow(swipe.offset),
          }}
        >
          <div ref={bannerRef} className="relative aspect-video w-full" {...swipe.handlers} style={{ maxHeight: "52svh", touchAction: "none" }}>
            {backdrop ?? poster ? (
              <FadeInImg src={(backdrop ?? poster)!} alt="" data-sheet-photo="" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 bg-surface" />
            )}
            <div data-sheet-veil="" className="absolute inset-0 bg-linear-to-t from-ink via-ink/20 to-transparent" />
            <button
              type="button"
              {...NOT_THE_HANDLE}
              onClick={exit.requestClose}
              aria-label={t("cinema.back")}
              ref={liquidButtonRef}
              data-liquid
              data-sheet-glass=""
              className="nav-glass absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-white"
            >
              <X size={18} />
            </button>
          </div>

          <div data-sheet-content="" className={`relative -mt-6 px-4 pb-16 ${short ? "mx-auto w-full max-w-xl" : ""}`}>
            <PhoneSheetTitle title={name} logoUrl={logo} />
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted">
              {metaItems.map((m) => (
                <span key={String(m)}>{m}</span>
              ))}
              <BetaBadge />
            </div>

            {next && next.state !== "failed" && <OfflinePlayButton download={next} variant="wide" episodeCode={nextCode} />}
            {film?.state === "failed" && (
              <>
                <p className="mb-2 text-sm text-warning">
                  {offlineStatusLabel(film, t)}
                  {film.error ? ` · ${film.error}` : ""}
                </p>
                <button
                  type="button"
                  data-liquid-pan="wide"
                  onClick={() => void retryOfflineDownload(film.id)}
                  className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-base font-semibold text-ink"
                >
                  <RotateCcw size={18} />
                  {t("player.downloads.retry")}
                </button>
              </>
            )}
            {film && arriving && (
              <>
                <div className="mb-2">
                  <ProgressLine download={film} />
                </div>
                <button
                  type="button"
                  data-liquid-pan="wide"
                  onClick={() => void (paused ? resumeOfflineDownload(film.id) : pauseOfflineDownload(film.id))}
                  className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white"
                >
                  {paused ? <Download size={16} /> : <Pause size={16} />}
                  {paused ? t("player.downloads.resumeDownload") : t("player.downloads.pause")}
                </button>
              </>
            )}
            {film && (
              <p className="mb-3 mt-2 text-xs text-subtle">
                {t(`player.downloads.${film.quality}`)} · {film.audioLabel}
                {film.state === "done" ? <> · {formatFileSize(film.bytes, locale)}</> : null}
              </p>
            )}
            {facts?.overview && <p className="mb-3 text-sm leading-6 text-white">{facts.overview}</p>}
            {cast && <div className="mb-5">{cast}</div>}

            {/* La rangée d'icônes des fiches du téléphone : de grandes cibles, rien qui dispute le blanc de Lire. */}
            {(film || (openOnline && onlineTarget)) && (
              <div className="mb-6 flex items-start gap-8">
                {film && (
                  <button type="button" onClick={() => setConfirming(true)} data-liquid-pan="icon" className="flex w-16 flex-col items-center gap-1.5">
                    <Trash2 size={22} className="text-danger" />
                    <span className="text-center text-xs leading-tight text-muted">{removeLabel}</span>
                  </button>
                )}
                {openOnline && onlineTarget && (
                  <button type="button" onClick={() => openOnline(onlineTarget)} data-liquid-pan="icon" className="flex w-16 flex-col items-center gap-1.5">
                    {film ? <Film size={22} className="text-white" /> : <Tv size={22} className="text-white" />}
                    <span className="text-center text-xs leading-tight text-muted">{t("player.downloads.openShort")}</span>
                  </button>
                )}
              </div>
            )}
            {episodeList}
          </div>
        </div>
        {removal}
        {overviewSheet}
      </>,
      document.body
    );
  }

  return createPortal(
    <>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        className={`fixed inset-0 overflow-hidden bg-ink ${morph.handlesEntry ? "" : "animate-fade-in"}`}
        style={{
          zIndex: 48,
          ...exit.style,
          paddingLeft: "calc(var(--player-rail, 0px) + env(safe-area-inset-left, 0px))",
          paddingRight: "env(safe-area-inset-right, 0px)",
        }}
      >
        {(backdrop ?? poster) && <FadeInImg src={(backdrop ?? poster)!} alt="" data-sheet-photo="" className="absolute inset-0 h-full w-full object-cover" />}
        <div
          data-sheet-settle=""
          className="absolute inset-x-0 bottom-0 md:backdrop-blur-md"
          style={{ height: "45%", maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)", WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)" }}
        />
        <div data-sheet-veil="" className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
        <div data-sheet-veil="" className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />
        <button
          type="button"
          onClick={exit.requestClose}
          className="btn btn-ghost absolute z-10 rounded-full bg-black/55 px-3 py-2 float-edge"
          style={{ top: "max(1rem, env(safe-area-inset-top))", left: "calc(1rem + var(--player-rail, 0px))" }}
        >
          <ArrowLeft size={16} /> {t("cinema.back")}
        </button>

        <CinemaDetailPages
          first={
            <div
              data-sheet-content=""
              style={COLUMN_STYLE}
              className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16 ${detailColumnMotion({ leaving: false, revealed: morph.handlesEntry })}`}
            >
              <CinemaDetailTitle title={name} logoUrl={logo} />
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
                {metaItems.map((m) => (
                  <span key={String(m)}>{m}</span>
                ))}
                <BetaBadge />
              </div>
              {facts?.overview && <CinemaOverview text={facts.overview} readMore={t("cinema.readMore")} maxLines={5} onOpen={() => setOverviewOpen(true)} />}
              {cast}
              {film && (
                <p className="text-xs text-subtle">
                  {t(`player.downloads.${film.quality}`)} · {film.audioLabel}
                  {film.state === "done" ? <> · {formatFileSize(film.bytes, locale)}</> : null}
                </p>
              )}

              <div data-detail-actions className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
                {next && next.state !== "failed" && (
                  <OfflinePlayButton download={next} variant="row" episodeCode={nextCode} rowClassName={`${MENU_ROW} ${MENU_ROW_INACTIVE}`} badgeClassName={MENU_BADGE} />
                )}
                {film?.state === "failed" && (
                  <button type="button" data-detail-menu onClick={() => void retryOfflineDownload(film.id)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                    <span className={MENU_BADGE}>
                      <RotateCcw size={14} />
                    </span>
                    <span className="flex min-w-0 flex-col items-start leading-tight">
                      <span className="text-sm font-medium">{t("player.downloads.retry")}</span>
                      <span className="truncate text-[11px] opacity-70">{film.error ?? offlineStatusLabel(film, t)}</span>
                    </span>
                  </button>
                )}
                {film && arriving && (
                  <>
                    <div className="px-3 py-1">
                      <ProgressLine download={film} />
                    </div>
                    <button type="button" data-detail-menu onClick={() => void (paused ? resumeOfflineDownload(film.id) : pauseOfflineDownload(film.id))} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                      <span className={MENU_BADGE}>{paused ? <Download size={14} /> : <Pause size={14} />}</span>
                      <span className="text-sm font-medium">{paused ? t("player.downloads.resumeDownload") : t("player.downloads.pause")}</span>
                    </button>
                  </>
                )}
                {film && (
                  <button type="button" data-detail-menu onClick={() => setConfirming(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                    <span className={MENU_BADGE}>
                      <Trash2 size={14} />
                    </span>
                    <span className="text-sm font-medium">{removeLabel}</span>
                  </button>
                )}
                {openOnline && onlineTarget && (
                  <button type="button" data-detail-menu onClick={() => openOnline(onlineTarget)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                    <span className={MENU_BADGE}>{film ? <Film size={14} /> : <Tv size={14} />}</span>
                    <span className="text-sm font-medium">{t("player.downloads.openShort")}</span>
                  </button>
                )}
              </div>
            </div>
          }
          below={episodeList || undefined}
        />
      </div>
      {removal}
      {overviewSheet}
    </>,
    document.body
  );
}

/** L'avancement d'un film qui arrive encore : la barre, l'état à gauche, les tailles à droite. */
function ProgressLine({ download: d }: { download: OfflineDownload }) {
  const t = useT();
  const { locale } = useLocale();
  const pct = offlineProgress(d);
  return (
    <div>
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
 * Une ligne d'épisode, la forme de celles des fiches du cinéma (`CinemaMobileDetail`,
 * `CinemaEpisodeBrowser`) : toute la ligne lance l'épisode depuis l'appareil — vignette et son rond de
 * lecture, coche « vu », barre de reprise ; le numéro et le titre ; le temps restant ; le résumé. À
 * droite, l'icône de l'état du téléchargement, qui ouvre ses gestes (`DownloadStateButton`).
 */
function EpisodeRow({ download: d, size }: { download: OfflineDownload; size: "phone" | "desktop" }) {
  const t = useT();
  const playback = usePlayback();
  const thumbnail = useOfflineImage(d, POSTER_FILE, d.hasPoster);
  const playable = offlinePlayable(d);
  const remaining = offlineRemainingSeconds(d);
  const title = `${d.episode?.episodeNumber ?? "–"}. ${d.episode?.episodeTitle || d.title}`;
  const play = () => playable && playback.play({ itemId: d.itemId, title: d.title, resumeAt: d.watchedToEnd ? 0 : d.positionSeconds, offline: { id: d.id } });
  const phone = size === "phone";
  return (
    <div className="flex items-start gap-1">
      <button
        type="button"
        data-nav-item
        aria-disabled={!playable || undefined}
        onClick={play}
        className={`flex min-w-0 flex-1 gap-3 rounded-lg text-left transition-colors active:transform-none active:bg-white/10 active:delay-75 ${phone ? "" : "items-start gap-4 p-3 hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"}`}
      >
        <div className={`relative shrink-0 ${phone ? "w-32" : "w-40 sm:w-48"}`}>
          {thumbnail ? (
            <PosterImage src={thumbnail} alt={title} aspectRatio="aspect-video" unoptimized subtle />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-lg bg-white/8 text-subtle">
              <Tv size={18} />
            </div>
          )}
          {playable && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white">
                <Play size={14} fill="currentColor" />
              </span>
            </span>
          )}
          {d.watchedToEnd && (
            <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand-strong">
              <Check size={10} className="text-white" />
            </span>
          )}
          <CinemaEpisodeProgress
            resumeTicks={remaining !== null ? d.positionSeconds * 1e7 : null}
            runtimeTicks={d.runtimeSeconds ? d.runtimeSeconds * 1e7 : null}
            watched={d.watchedToEnd === true}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">{title}</p>
          {d.state !== "done" ? (
            <p className="mt-0.5 text-xs text-subtle">{offlineStatusLabel(d, t)}</p>
          ) : remaining !== null && !d.watchedToEnd ? (
            <p className="mt-0.5 text-xs text-accent-400">{t("cinema.timeRemaining", { time: formatDurationShort(remaining * 1e7) })}</p>
          ) : (
            d.runtimeSeconds > 0 && <p className="mt-0.5 text-xs text-subtle">{formatMinutes(Math.round(d.runtimeSeconds / 60))}</p>
          )}
          {d.artwork?.overview && <p className={`mt-1 text-xs leading-5 text-muted ${phone ? "line-clamp-3" : "line-clamp-2"}`}>{d.artwork.overview}</p>}
        </div>
      </button>
      <DownloadStateButton download={d} name={title} poster={thumbnail} size={size} className={phone ? "mt-4" : "mt-3"} />
    </div>
  );
}

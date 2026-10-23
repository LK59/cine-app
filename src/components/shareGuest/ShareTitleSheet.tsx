"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { Check, ListVideo, Play, Video } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { ImdbBadge } from "@/components/ImdbBadge";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { PlayButton } from "@/components/PlayButton";
import { usePlayback } from "@/components/PlaybackProvider";
import { playerHoldsKeyboard } from "@/lib/playerKeyboard";
import { usePlayerEnabledState } from "@/lib/usePlayerEnabled";
import { useIsMobile } from "@/lib/useIsMobile";
import { useJellyfinItemState } from "@/lib/useJellyfinItemState";
import { useLocale, useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, focusFirstAction, detailMenuArrowNav } from "@/components/cinema/detailMenu";
import { HORIZONTAL_VEIL, VERTICAL_VEIL, COLUMN_STYLE, MENU_STYLE, COLUMN_GAP, CAST_CLASS, CAST_SHOWN, CinemaOverview, CinemaDetailModal } from "@/components/cinema/CinemaDetailLayout";
import { CinemaDetailPages, CinemaDetailTitle, PhoneSheetTitle } from "@/components/cinema/CinemaDetailPages";
import { CinemaEpisodeBrowser } from "@/components/cinema/CinemaEpisodeBrowser";
import { CinemaEpisodeProgress } from "@/components/cinema/CinemaEpisodeProgress";
import { CinemaTagline, ReservedLine, useLateArrival, useRuntimeLabel } from "@/components/cinema/CinemaDetailExtras";
import { usePlaybackPrefetch } from "@/lib/usePlaybackPrefetch";
import { useNextEpisodeFromCache } from "@/lib/useNextEpisodeFromCache";
import { episodeRowFacts, playEpisodeFrom } from "@/lib/episodeRow";
import { openingSeason, orderSeasons } from "@/lib/seasonOrder";
import { sheetOverview, sheetRuntimeMinutes, sheetEpisodeRuntime, sheetLeadFacts, useSheetPlayFacts } from "@/lib/sheetFacts";
import { useFileMissing } from "@/lib/missingFiles";
import { FadeInImg } from "@/components/FadeInImg";
import { PosterImage } from "@/components/PosterImage";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaEpisode, CinemaEpisodesPayload, CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import type { ShareTitlePayload } from "@/app/api/share/title/route";

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });

/**
 * La fiche du titre d'un lien de partage (DECISIONS.md §112) — la page entière de l'invité.
 *
 * **Composée des pièces des fiches de l'application, pas des fiches elles-mêmes.** `CinemaMovieDetail`,
 * `CinemaSeriesDetail` et `CinemaMobileDetail` sont faites pour vivre au-dessus d'un catalogue : leur
 * entrée et leur sortie passent par le morph de l'affiche touchée (`useSheetMorph`, §61), leur
 * fermeture par l'adresse (`cinemaClose`, `useDelayedClose`), et elles demandent dès le montage ce que
 * la porte des liens refuse — « À voir » (`useWatchlistStatusMap`), titres similaires et saga (le
 * catalogue), ce qui manque à une série, le hors ligne. Y glisser un mode invité, c'était ajouter une
 * branche à chacun de ces crochets dans trois fichiers que tout le foyer utilise chaque soir, pour une
 * page qui n'a ni catalogue derrière elle, ni rien vers quoi se refermer. Ici, les mêmes pièces
 * (`CinemaDetailPages`, `CinemaDetailTitle`, voiles, menu, `PlayButton`, `CinemaEpisodeBrowser`), dans
 * la même disposition : l'invité voit la fiche de l'application, et les fiches du foyer n'ont pas
 * changé d'une ligne.
 *
 * Ce qui n'y est pas, exprès : la distribution ne mène à aucune personne (les noms sont du texte), ni
 * titres similaires, ni saga, ni « À voir », ni « Vu », ni favori, ni téléchargement, ni épisodes
 * manquants, ni bouton de fermeture — la fiche est la page. La bande-annonce reste (YouTube, rien de
 * la bibliothèque).
 *
 * Au bureau et sur la tablette, la fiche plein écran du bureau ; sur le téléphone, celle du téléphone
 * (bannière, boutons pleine largeur, épisodes sous la fiche) — le même partage que l'accueil
 * (`useIsMobile`).
 */
export function ShareTitleSheet({ payload }: { payload: ShareTitlePayload }) {
  const isMobile = useIsMobile();
  const facts = useShareSheetFacts(payload);
  return isMobile ? <PhoneLayout payload={payload} facts={facts} /> : <DesktopLayout payload={payload} facts={facts} />;
}

interface TitleInfo {
  imdbId?: string | null;
  tmdb: { overview: string; tagline?: string | null; cast: { tmdbId: number; name: string }[]; runtime?: number | null } | null;
  trailerKey: string | null;
}

type Facts = ReturnType<typeof useShareSheetFacts>;

/** L'adresse de la liste des épisodes — la même clé que la fiche série et le menu du lecteur. */
const episodesKeyOf = (seriesId: string) => `/api/cinema/series/${seriesId}/episodes`;

/**
 * Ce que les deux dispositions lisent : la description (accroche, distribution, bande-annonce), la
 * position, l'épisode que Lire lancerait — par les mêmes fonctions que les fiches de l'application
 * (`sheetLeadFacts`, `useSheetPlayFacts`), sur les mêmes routes, toutes ouvertes au lien.
 */
function useShareSheetFacts(payload: ShareTitlePayload) {
  const series = payload.kind === "series" ? payload.item : null;
  const movie = payload.kind === "movie" ? payload.item : null;
  const item: CinemaMovie | CinemaSeries = payload.item;
  // Un titre que Jellyfin a seul (§89) aussi : ces routes le décrivent par TMDB, sous son identifiant
  // réservé, et la porte des liens accepte cette adresse pour le titre du lien (la règle `radarr` /
  // `sonarr` compare le nombre gardé par le lien). La fiche ne demandait rien, et l'invité n'avait ni
  // distribution ni repli d'accroche ou de bande-annonce, que le foyer a (audit du 23/10/2026).
  const infoKey = movie ? `/api/radarr/movies/${movie.radarrId}/info` : `/api/sonarr/series/${series!.sonarrId}/info`;
  const { data: info, error: infoError } = useSWR<TitleInfo>(infoKey, fetcher);
  const infoSettled = info !== undefined || infoError !== undefined;
  const late = useLateArrival(infoSettled);
  const lead = sheetLeadFacts(item, info, infoSettled);

  // La position d'un film (Jellyfin, par le compte du lien) ; rien pour une série, dont c'est la liste
  // des épisodes qui dit où l'on en est.
  const { progress } = useJellyfinItemState(movie ? movie.jellyfinItemId : null);
  const episodesKey = series ? episodesKeyOf(series.jellyfinItemId) : null;
  const { data: episodesData, error: episodesError } = useSWR<CinemaEpisodesPayload>(episodesKey, fetcher);
  const play = useSheetPlayFacts(
    series
      ? { kind: "series", jellyfinItemId: series.jellyfinItemId, sonarrId: series.sonarrId, firstEpisode: series.firstEpisode }
      : { kind: "movie", jellyfinItemId: item.jellyfinItemId },
    item.title,
    series
      ? episodesData
        ? { kind: "series", known: true, episode: episodesData.nextEpisode }
        : undefined
      : progress
        ? { kind: "movie", known: progress.known === true, resumeTicks: progress.resumeTicks, runtimeTicks: progress.runtimeTicks }
        : undefined
  );
  // Une série jamais commencée : la ligne de lecture garde sa place jusqu'à la liste des épisodes.
  const playPending = !!series && !play.targetId && episodesData === undefined && episodesError === undefined;
  // Les lectures du lien sont prises ailleurs : Lire est remplacé par la phrase, avant que le serveur
  // ne refuse l'ouverture (`shareStreamRefusal`).
  const full = payload.playingElsewhere >= payload.maxStreams;
  const fileMissing = useFileMissing(play.targetId);
  // Ce que Lire va demander, demandé dès l'ouverture — comme une fiche du foyer. Pas quand le lien est
  // plein : la description serait refusée de toute façon.
  usePlaybackPrefetch(full ? null : play.targetId);
  // Relu à l'appel, pas figé au rendu — l'épisode suivant à la fin d'un épisode (`useNextEpisodeFromCache`).
  const nextOf = useNextEpisodeFromCache(episodesKeyOf(item.jellyfinItemId));
  const getNextEpisode = series ? nextOf : undefined;
  const runtimeMinutes = movie ? sheetRuntimeMinutes(movie.runtimeMinutes, info?.tmdb?.runtime) : null;
  const episodeRuntime = series ? sheetEpisodeRuntime(series.episodeRuntime, info?.tmdb?.runtime) : null;
  return {
    item,
    movie,
    series,
    info,
    late,
    lead,
    play,
    playPending,
    full,
    fileMissing,
    getNextEpisode,
    episodesData,
    // « Lire S1·É1 » supposé d'après le catalogue attend la liste — sauf si elle a échoué : la règle
    // de la fiche série du foyer, qui lance alors la supposition plutôt qu'un appui qui ne part jamais.
    episodesError: episodesError as unknown,
    runtimeMinutes,
    episodeRuntime,
    cast: info?.tmdb?.cast ?? [],
    overview: sheetOverview(item.overview, info?.tmdb?.overview),
  };
}

/** « Disponible jusqu'au 27 octobre à 21:30 » — dans la langue de la page. */
function useAvailableUntil(expiresAt: number): string {
  const t = useT();
  const { locale } = useLocale();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(new Date(expiresAt));
  return t("share.guest.availableUntil", { date });
}

/** Les noms de la distribution, en texte : un invité n'ouvre aucune fiche de personne. */
function CastText({ cast, className = "" }: { cast: { tmdbId: number; name: string }[]; className?: string }) {
  const t = useT();
  if (cast.length === 0) return null;
  const shown = cast.slice(0, CAST_SHOWN).map((c) => c.name).join(", ");
  return (
    <p data-share-cast="" className={`${CAST_CLASS} ${className}`}>
      {t("cinema.cast")} {shown}
      {cast.length > CAST_SHOWN ? ` +${cast.length - CAST_SHOWN}` : ""}
    </p>
  );
}

/** Le titre d'un lien est déjà lu ailleurs par le nombre d'appareils permis : la phrase remplace Lire. */
function StreamsFullNotice({ max, className }: { max: number; className: string }) {
  const t = useT();
  return (
    <p role="status" data-share-streams-full="" className={className}>
      {t("share.guest.streamsFull", { n: max })}
    </p>
  );
}

// ─── Bureau et tablette ──────────────────────────────────────────────────────

function DesktopLayout({ payload, facts }: { payload: ShareTitlePayload; facts: Facts }) {
  const t = useT();
  const playback = usePlayback();
  const containerRef = useRef<HTMLDivElement>(null);
  const userMovedFocus = useRef(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const [showSynopsis, setShowSynopsis] = useState(false);
  // Local, et non dans l'adresse comme sur l'accueil : rien derrière cette page vers quoi revenir.
  const [showEpisodes, setShowEpisodes] = useState(false);
  const runtimeLabel = useRuntimeLabel();
  const until = useAvailableUntil(payload.expiresAt);
  const playerEnabled = usePlayerEnabledState();
  const { item, movie, series, lead, late, play } = facts;
  const seasons = facts.episodesData?.seasons ?? [];

  // Le premier geste de la télécommande tombe sur Lire, comme sur une fiche du foyer — repris quand
  // le bouton apparaît (lecture intégrée connue, épisode connu), tant que personne n'a bougé.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (showEpisodes || userMovedFocus.current) return;
      focusFirstAction(containerRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [playerEnabled, play.targetId, lead.trailerKey, showEpisodes]);

  // Les flèches parcourent le menu ; le lecteur au-dessus, l'écran des épisodes et les fenêtres ont
  // les leurs (un écran recouvert n'a pas d'avis).
  const playerOwnsKeyboard = playerHoldsKeyboard(playback);
  useEffect(() => {
    if (playerOwnsKeyboard || showEpisodes || showTrailer || showSynopsis) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      userMovedFocus.current = true;
      detailMenuArrowNav(e, containerRef.current);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playerOwnsKeyboard, showEpisodes, showTrailer, showSynopsis]);

  function playEpisode(ep: CinemaEpisode) {
    playEpisodeFrom(playback, ep, facts.getNextEpisode);
  }

  const label = formatContinueLabel(t, play.resumeTicks, play.runtimeTicks, play.seasonNumber, play.episodeNumber, play.rewatch);
  const metaRuntime = movie ? runtimeLabel(facts.runtimeMinutes, false) : runtimeLabel(facts.episodeRuntime?.minutes, true);

  return (
    <div ref={containerRef} data-share-sheet="desktop" className="fixed inset-0 overflow-hidden bg-ink animate-fade-in" style={{ paddingLeft: "var(--player-rail, 0px)" }}>
      {item.backdropUrl && <FadeInImg src={item.backdropUrl} alt="" data-sheet-photo="" className="absolute inset-0 h-full w-full object-cover" />}
      <div
        className="absolute inset-x-0 bottom-0 backdrop-blur-md"
        style={{
          height: "45%",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
        }}
      />
      <div data-sheet-veil="" className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
      <div data-sheet-veil="" className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />

      <CinemaDetailPages
        first={
          <div data-sheet-content="" style={COLUMN_STYLE} className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16`}>
            <CinemaDetailTitle title={item.title} logoUrl={item.logoUrl} />

            <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
              <span>{item.year}</span>
              {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
              {metaRuntime && <span className={series && facts.episodeRuntime?.late ? late.fade : ""}>{metaRuntime}</span>}
              {movie && <QualityBadges quality={movie.quality} />}
              {item.genres.length > 0 && <span>{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>}
            </div>

            {!lead.taglineKnown ? <ReservedLine className="h-[1.1rem]" /> : <CinemaTagline text={lead.tagline} className={lead.taglineLate ? late.fade : ""} />}

            <CinemaOverview text={facts.overview} readMore={t("cinema.readMore")} maxLines={5} onOpen={() => setShowSynopsis(true)} />

            {late.pending && <ReservedLine className="h-4" />}
            <CastText cast={facts.cast} className={late.fade} />

            <div data-detail-actions className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
              {facts.full ? (
                <StreamsFullNotice max={payload.maxStreams} className="rounded-lg bg-white/10 px-4 py-2.5 text-sm text-white" />
              ) : (
                <>
                  {facts.playPending && (
                    <div aria-hidden="true" data-sheet-reserved="" className={`${MENU_ROW} ${MENU_ROW_INACTIVE} invisible`}>
                      <span className={MENU_BADGE} />
                      <span className="text-sm font-medium">{t("common.play")}</span>
                    </div>
                  )}
                  {play.targetId && (
                    <PlayButton
                      itemId={play.targetId}
                      title={play.title}
                      resumeTicks={play.resumeTicks ?? undefined}
                      runtimeTicks={play.runtimeTicks ?? undefined}
                      resumeKnown={play.resumeKnown}
                      unavailable={facts.fileMissing}
                      reserve
                      waitForServer={play.guessed && facts.episodesError === undefined}
                      getNextEpisode={facts.getNextEpisode}
                      variant="row"
                      label={label}
                      className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
                    />
                  )}
                  {play.targetId && (
                    <PlayButton
                      restart
                      itemId={play.targetId}
                      title={play.title}
                      resumeTicks={play.resumeTicks ?? undefined}
                      unavailable={facts.fileMissing}
                      getNextEpisode={facts.getNextEpisode}
                      variant="row"
                      label={t("cinema.restartFromBeginning")}
                      className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
                    />
                  )}
                </>
              )}

              {!lead.trailerKnown && (
                <div aria-hidden="true" data-sheet-reserved="" className={`${MENU_ROW} ${MENU_ROW_INACTIVE} invisible`}>
                  <span className={MENU_BADGE}>
                    <Video size={14} />
                  </span>
                  <span className="text-sm font-medium">{t("cinema.trailer")}</span>
                </div>
              )}
              {lead.trailerKey && (
                <button data-detail-menu onClick={() => setShowTrailer(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE} ${lead.trailerLate ? late.fade : ""}`}>
                  <span className={MENU_BADGE}>
                    <Video size={14} />
                  </span>
                  <span className="text-sm font-medium">{t("cinema.trailer")}</span>
                </button>
              )}

              {series && seasons.length > 0 && (
                <button data-detail-menu onClick={() => setShowEpisodes(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                  <span className={MENU_BADGE}>
                    <ListVideo size={14} />
                  </span>
                  <span className="text-sm font-medium">{t("cinema.moreEpisodes")}</span>
                </button>
              )}
            </div>

            <p data-share-until="" className="text-xs text-subtle">
              {until}
            </p>
          </div>
        }
      />

      {showTrailer && lead.trailerKey && (
        <TrailerModal
          youtubeKey={lead.trailerKey}
          title={item.title}
          onClose={() => {
            setShowTrailer(false);
            requestAnimationFrame(() => focusFirstAction(containerRef.current));
          }}
        />
      )}

      {/* L'écran des épisodes de l'application, sans ce que le lien n'a pas : ni `sonarrId` (ce qui
          manque, à demander), ni `seriesItemId` (le téléchargement hors ligne) — voir ses props.
          Un épisode ne se lance que si le lien a encore une lecture libre. */}
      {showEpisodes && series && seasons.length > 0 && (
        <CinemaEpisodeBrowser
          title={item.title}
          seasons={seasons}
          posterUrl={item.posterUrl}
          nextEpisodeId={facts.episodesData?.nextEpisode?.itemId}
          onClose={() => {
            setShowEpisodes(false);
            requestAnimationFrame(() => focusFirstAction(containerRef.current));
          }}
          onPlayEpisode={(ep) => {
            if (!facts.full) playEpisode(ep);
          }}
        />
      )}

      {showSynopsis && (
        <CinemaDetailModal
          title={item.title}
          closeLabel={t("common.close")}
          onClose={() => {
            setShowSynopsis(false);
            requestAnimationFrame(() => focusFirstAction(containerRef.current));
          }}
        >
          <p>{facts.overview}</p>
        </CinemaDetailModal>
      )}
    </div>
  );
}

// ─── Téléphone ───────────────────────────────────────────────────────────────

/** Le bouton blanc pleine largeur de la fiche du téléphone. */
const PHONE_PRIMARY = "mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-base font-semibold text-ink";
const PHONE_SECONDARY = "mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white";

function PhoneLayout({ payload, facts }: { payload: ShareTitlePayload; facts: Facts }) {
  const t = useT();
  const playback = usePlayback();
  const [showTrailer, setShowTrailer] = useState(false);
  const runtimeLabel = useRuntimeLabel();
  const until = useAvailableUntil(payload.expiresAt);
  const { item, movie, series, lead, late, play } = facts;
  const metaRuntime = movie ? runtimeLabel(facts.runtimeMinutes, false) : runtimeLabel(facts.episodeRuntime?.minutes, true);
  const label = formatContinueLabel(t, play.resumeTicks, play.runtimeTicks, play.seasonNumber, play.episodeNumber, play.rewatch);

  return (
    <div data-share-sheet="phone" className="safe-x min-h-dvh bg-ink animate-fade-in">
      <div className="relative aspect-video w-full" style={{ maxHeight: "52svh" }}>
        {item.backdropUrl ? (
          <FadeInImg src={item.backdropUrl} alt="" data-sheet-photo="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-surface" />
        )}
        <div data-sheet-veil="" className="absolute inset-0 bg-linear-to-t from-ink via-ink/20 to-transparent" />
      </div>

      <div data-sheet-content="" className="relative -mt-6 px-4 pb-16" style={{ paddingBottom: "max(4rem, calc(env(safe-area-inset-bottom, 0px) + 2rem))" }}>
        <PhoneSheetTitle title={item.title} logoUrl={item.logoUrl} />

        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>{item.year}</span>
          {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
          {series?.seasonCount ? <span>{t("cinema.seasonCount", { n: series.seasonCount })}</span> : null}
          {metaRuntime && <span className={series && facts.episodeRuntime?.late ? late.fade : ""}>{metaRuntime}</span>}
          {movie && <QualityBadges quality={movie.quality} />}
          {item.genres.length > 0 && <span className="truncate">{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>}
        </div>

        {facts.full ? (
          <StreamsFullNotice max={payload.maxStreams} className="mb-2 rounded-lg bg-white/10 px-4 py-3 text-center text-sm text-white" />
        ) : (
          <>
            {facts.playPending && (
              <div aria-hidden="true" data-sheet-reserved="" className={`invisible ${PHONE_PRIMARY}`}>
                <Play size={18} />
                {t("common.play")}
              </div>
            )}
            {play.targetId && (
              <PlayButton
                itemId={play.targetId}
                title={play.title}
                resumeTicks={play.resumeTicks ?? undefined}
                runtimeTicks={play.runtimeTicks ?? undefined}
                resumeKnown={play.resumeKnown}
                unavailable={facts.fileMissing}
                reserve
                waitForServer={play.guessed && facts.episodesError === undefined}
                getNextEpisode={facts.getNextEpisode}
                iconSize={18}
                label={label}
                className={PHONE_PRIMARY}
              />
            )}
            {play.targetId && (
              <PlayButton
                restart
                itemId={play.targetId}
                title={play.title}
                resumeTicks={play.resumeTicks ?? undefined}
                unavailable={facts.fileMissing}
                getNextEpisode={facts.getNextEpisode}
                iconSize={16}
                label={t("cinema.restartFromBeginning")}
                className={PHONE_SECONDARY}
              />
            )}
          </>
        )}

        {!lead.trailerKnown && <ReservedLine className="mb-4 h-[2.75rem]" />}
        {lead.trailerKey && (
          <button type="button" onClick={() => setShowTrailer(true)} className={`${PHONE_SECONDARY} mb-4 ${lead.trailerLate ? late.fade : ""}`}>
            <Video size={16} />
            {t("cinema.trailer")}
          </button>
        )}

        {!lead.taglineKnown ? (
          <ReservedLine className="mb-1.5 h-[1.1rem]" />
        ) : (
          <CinemaTagline text={lead.tagline} className={`mb-1.5 ${lead.taglineLate ? late.fade : ""}`} />
        )}
        <p className="mb-3 text-sm leading-6 text-white">{facts.overview}</p>
        <CastText cast={facts.cast} className={`mb-3 ${late.fade}`} />
        <p data-share-until="" className="mb-6 text-xs text-subtle">
          {until}
        </p>

        {series && facts.episodesData && facts.episodesData.seasons.length > 0 && (
          <PhoneEpisodes
            seasons={facts.episodesData.seasons}
            nextEpisodeId={facts.episodesData.nextEpisode?.itemId}
            disabled={facts.full}
            onPlay={(ep) => playEpisodeFrom(playback, ep, facts.getNextEpisode)}
          />
        )}
      </div>

      {showTrailer && lead.trailerKey && <TrailerModal youtubeKey={lead.trailerKey} title={item.title} onClose={() => setShowTrailer(false)} />}
    </div>
  );
}

/**
 * Les épisodes sous la fiche du téléphone : les pastilles de saison et les lignes de la fiche du
 * téléphone, sans le téléchargement ni ce qui manque (qu'un lien ne demande pas).
 */
function PhoneEpisodes({
  seasons,
  nextEpisodeId,
  disabled,
  onPlay,
}: {
  seasons: CinemaSeason[];
  nextEpisodeId: string | undefined;
  disabled: boolean;
  onPlay: (episode: CinemaEpisode) => void;
}) {
  const t = useT();
  const playerEnabled = usePlayerEnabledState();
  const seasonNumbers = useMemo(() => orderSeasons(seasons.map((s) => s.seasonNumber)), [seasons]);
  // La saison de l'épisode à suivre, sinon la règle de la fiche (`openingSeason`) — figée au montage.
  const [selected, setSelected] = useState<number | null>(
    () => seasons.find((s) => s.episodes.some((ep) => ep.jellyfinItemId === nextEpisodeId))?.seasonNumber ?? openingSeason(seasons.map((s) => s.seasonNumber), [])
  );
  const active = selected !== null && seasonNumbers.includes(selected) ? selected : (seasonNumbers[0] ?? null);
  const episodes = seasons.find((s) => s.seasonNumber === active)?.episodes ?? [];
  const playable = playerEnabled === true && !disabled;

  return (
    <div data-share-episodes="">
      {seasonNumbers.length > 1 && (
        <div className="scrollbar-thin -mx-4 mb-3 flex gap-2 overflow-x-auto px-4">
          {seasonNumbers.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setSelected(n)}
              className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-sm transition-colors ${n === active ? "bg-white font-medium text-ink" : "bg-white/10 text-muted"}`}
            >
              {n === 0 ? t("cinema.specials") : t("cinema.season", { n })}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-4">
        {episodes.map((episode) => {
          // Le temps restant ou la durée, et « À suivre » : la règle des trois listes (`episodeRowFacts`).
          const row = episodeRowFacts(episode, nextEpisodeId);
          return (
          <button
            key={episode.jellyfinItemId}
            type="button"
            aria-disabled={!playable || undefined}
            onClick={() => {
              if (playable) onPlay(episode);
            }}
            className="flex w-full min-w-0 gap-3 rounded-lg text-left transition-colors active:transform-none active:bg-white/10 active:delay-75"
          >
            <div className="relative w-32 shrink-0">
              <PosterImage src={episode.thumbnailUrl} alt={episode.title} aspectRatio="aspect-video" unoptimized subtle />
              {playable && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white">
                    <Play size={14} fill="currentColor" />
                  </span>
                </span>
              )}
              {episode.watched && (
                <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand-strong">
                  <Check size={10} className="text-white" />
                </span>
              )}
              <CinemaEpisodeProgress resumeTicks={episode.resumeTicks} runtimeTicks={episode.runtimeTicks} watched={episode.watched} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white">
                {episode.episodeNumber}. {episode.title}
                {row.isNext && (
                  <span className="ml-2 inline-block whitespace-nowrap rounded-full bg-accent-600/25 px-2 py-0.5 text-xs font-medium text-accent-400">
                    {t("cinema.nextUpBadge")}
                  </span>
                )}
              </p>
              {row.remaining !== null ? (
                <p className="mt-0.5 text-xs text-accent-400">{t("cinema.timeRemaining", { time: row.remaining })}</p>
              ) : (
                row.runtime !== null && <p className="mt-0.5 text-xs text-subtle">{row.runtime}</p>
              )}
              {episode.overview && <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted">{episode.overview}</p>}
            </div>
          </button>
          );
        })}
      </div>
    </div>
  );
}

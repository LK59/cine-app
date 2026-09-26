"use client";

import { defaultSeason, missingCount, orderSeasons } from "@/lib/seasonOrder";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { BookmarkCheck, Check, ChevronDown, CircleCheck, Play, Plus, RotateCcw, Video, X } from "lucide-react";
import { fetcher, progressKey } from "@/lib/swr";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { arrivedByBack, markSheetLeaving, useSheetBehind, useRouteBehind } from "@/lib/cinemaRoute";
import { useSwipeToDismiss, NOT_THE_HANDLE } from "@/lib/useSwipeToDismiss";
import { canJoinWatchlist, useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useJellyfinItemState } from "@/lib/useJellyfinItemState";
import { SHEET_OUT_MS, sheetMotionClass, phoneSheetCorner } from "@/lib/sheetMotion";
import { playerHoldsKeyboard } from "@/lib/playerKeyboard";
import { useWatchlistStatusMap } from "@/lib/useWatchlistStatusMap";
import { usePlayerEnabledState } from "@/lib/usePlayerEnabled";
import { usePlayback } from "@/components/PlaybackProvider";
import { PosterImage } from "@/components/PosterImage";
import { useIsShortViewport } from "@/lib/useIsMobile";
import { usePlayerSeriesRequests } from "@/lib/usePlayerSeriesRequests";
import { CinemaMissingEpisodes } from "@/components/cinema/CinemaMissingEpisodes";
import { CinemaEpisodeProgress } from "@/components/cinema/CinemaEpisodeProgress";
import { formatDurationShort, formatMinutes } from "@/lib/format";
import { ImdbBadge } from "@/components/ImdbBadge";
import { QualityBadges } from "@/components/cinema/QualityBadges";
import { CinemaSimilarRow, useCinemaSimilar } from "@/components/cinema/CinemaSimilarRow";
import { CinemaMovieCollectionRow } from "@/components/cinema/CinemaCollectionRow";
import { CinemaCastRow, type CinemaCastMember } from "@/components/cinema/CinemaCastRow";
import { useT } from "@/components/TranslationProvider";
import { genreLabel } from "@/lib/top10Label";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaProgressPayload } from "@/app/api/cinema/progress/[itemId]/route";
import type { CinemaEpisodesPayload, CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { resumeAtFor } from "@/lib/resumePosition";
import { useNextEpisodeFromCache } from "@/lib/useNextEpisodeFromCache";
import { usePlaybackPrefetch } from "@/lib/usePlaybackPrefetch";
import { CinemaTagline, ReservedLine, useLateArrival, useRuntimeLabel } from "@/components/cinema/CinemaDetailExtras";
import { sheetOverview, sheetRuntimeMinutes, useSheetPlayFacts } from "@/lib/sheetFacts";
import { useFileMissing } from "@/lib/missingFiles";
import { FadeInImg } from "@/components/FadeInImg";
import { ToggleGlyph } from "@/components/ToggleGlyph";

/** Un visage sans personne : ce qui donne sa hauteur à la place tenue de la distribution. */
const RESERVED_CAST: CinemaCastMember[] = [{ tmdbId: 0, name: "\u00a0", character: "\u00a0", photoUrl: null }];

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });

interface DetailInfo {
  /** `runtime` est la durée du film en minutes : elle vient de TMDB, comme le synopsis. */
  tmdb: { overview: string; tagline?: string | null; cast: CinemaCastMember[]; runtime?: number | null } | null;
  trailerKey: string | null;
}

// Netflix's own mobile title page: a 16:9 preview up top, then title/meta, a white primary
// action, the synopsis, a row of icon actions, and — for a series — the season's episode list.
//
// One component for both media types here, unlike the desktop pair (CinemaMovieDetail /
// CinemaSeriesDetail): on mobile this is a single scrolling column whose two branches are small
// and local (which /info endpoint to read, and whether an episode list follows), so splitting it
// would mean two near-identical 300-line files rather than the genuinely diverging layouts the
// desktop split exists for.
/**
 * La durée de `sheet-out` — et, à dessein, celle du retour du geste dans `useSwipeToDismiss`.
 *
 * Les deux façons de refermer une fiche, le bouton et le doigt, doivent mettre exactement le même
 * temps : sinon l'une des deux démonte la carte avant qu'elle n'ait fini de descendre.
 */


export function CinemaMobileDetail({
  item,
  mediaType,
  onClose,
  onSelectSimilar,
  underneath = false,
}: {
  item: CinemaMovie | CinemaSeries;
  mediaType: "movies" | "series";
  onClose: () => void;
  // Swaps this sheet's subject when a "Titres similaires" poster is tapped, rather than stacking
  // a second sheet on top of it.
  onSelectSimilar?: (item: CinemaMovie | CinemaSeries) => void;
  /**
   * Cette instance est dessinée *sous* une autre, pour qu'on la voie pendant qu'on tire celle du
   * dessus vers le bas. Elle est décorative : pas de geste, pas de clavier, pas de fermeture
   * automatique, et rien qui réponde au doigt — sans quoi deux fiches se disputeraient les mêmes
   * touches et le même pointeur.
   */
  underneath?: boolean;
}) {
  const t = useT();
  const runtimeLabel = useRuntimeLabel();
  const short = useIsShortViewport();
  const playback = usePlayback();
  // `undefined` tant qu'on ne sait pas : le bouton Lire garde alors sa place au lieu de surgir.
  const playerEnabled = usePlayerEnabledState();
  const [showTrailer, setShowTrailer] = useState(false);
  // Monté parce qu'on revient dessus, et non parce qu'on l'ouvre : pas d'animation d'entrée. Il
  // n'ouvre rien, il se découvre — voir `arrivedByBack`. Lu une seule fois, au montage.
  const [revealed] = useState(() => arrivedByBack());
  // La sortie est de nouveau animée, y compris quand une autre fiche attend derrière : elle en
  // découvrait l'accueil quand la fiche du dessous n'était pas dessinée, ce qui n'est plus le cas
  // (voir la pile dans CinemaMobileClient). La carte redescend donc par où elle est venue, et ce
  // qu'elle recouvrait apparaît sous elle au fur et à mesure.
  /**
   * Une sortie qui ne découvre rien ne doit pas durer — mais elle en découvre presque toujours.
   *
   * La carte redescend par où elle est venue, et ce qu'elle recouvrait apparaît sous elle au fur
   * et à mesure : c'est ce qui fait l'empilement des « titres similaires », et depuis le
   * 19/09/2026 c'est vrai aussi de la fiche personne, que la coquille redessine dessous à partir
   * de l'entrée d'historique (voir `SheetRef.person`). Avant cela il n'y avait rien sous le film
   * ouvert depuis une filmographie, et sa sortie découvrait l'écran de recherche, deux crans plus
   * bas — l'acteur ne reparaissait qu'à la fin.
   *
   * Reste le cas où rien n'est dessiné derrière : quelque chose attend (`useSheetBehind`) mais
   * l'entrée ne le nomme pas (`useRouteBehind`). L'animation découvrirait alors l'accueil, donc on
   * la supprime et l'échange se fait dans un seul rendu.
   */
  const behindIsDrawn = useRouteBehind() !== null;
  const swapsInPlace = useSheetBehind() && !behindIsDrawn;
  const { closing, requestClose } = useDelayedClose(onClose, swapsInPlace ? 0 : SHEET_OUT_MS);
  // La barre du bas attendait que l'adresse change, donc la fin de cette sortie, pour revenir.
  useEffect(() => {
    if (closing) markSheetLeaving();
  }, [closing]);
  const similar = useCinemaSimilar(item, mediaType);
  // Grab the banner and pull the sheet away — see the hook. Only the artwork above the title is
  // a handle; everything from the Lire button down scrolls as usual.
  const swipe = useSwipeToDismiss(requestClose);
  // Une fiche du dessous ne se ferme pas : elle attend qu'on la découvre.
  const inert = underneath;

  const isSeries = mediaType === "series";
  const infoUrl = isSeries
    ? `/api/sonarr/series/${(item as CinemaSeries).sonarrId}/info`
    : `/api/radarr/movies/${(item as CinemaMovie).radarrId}/info`;
  const { data: info, error: infoError } = useSWR<DetailInfo>(infoUrl, fetcher);
  // L'accroche, la bande-annonce et la distribution n'arrivent que par cette réponse : leur place
  // est tenue dès l'ouverture, et elles s'y posent en fondu — voir `useLateArrival`.
  const late = useLateArrival(info !== undefined || infoError !== undefined);

  // Movies carry their resume point on a per-user endpoint (the library payload is shared across
  // viewers); a series' equivalent is whichever episode Jellyfin says is next up.
  const { data: progress } = useSWR<CinemaProgressPayload>(
    // Voir `progressKey` : la même clé que celle que la relecture après lecture invalide.
    isSeries ? null : progressKey(item.jellyfinItemId),
    fetcher
  );
  const { data: episodesData, error: episodesError } = useSWR<CinemaEpisodesPayload>(
    isSeries ? `/api/cinema/series/${item.jellyfinItemId}/episodes` : null,
    fetcher
  );

  const tmdbId = item.tmdbId ?? 0;
  const statusMap = useWatchlistStatusMap(tmdbId ? [{ mediaType: isSeries ? "series" : "movie", tmdbId }] : []);
  const { addedStatus, addToWatchlist, removeFromWatchlist } = useAddToWatchlist(
    tmdbId ? statusMap[`${isSeries ? "series" : "movie"}:${tmdbId}`] ?? null : null
  );
  /**
   * « Vu » vient de Jellyfin, comme sur les fiches du bureau.
   *
   * Il était lu ici dans la table locale — la même colonne que « À voir », qui ne tient qu'un
   * statut par titre. Trois conséquences, toutes visibles : un film terminé sur la télé
   * s'affichait « pas vu » alors que l'onglet « Vu » de Ma liste, qui lit Jellyfin, le montrait
   * bien ; le marquer vu le sortait de « À voir » ; et le démarquer effaçait la ligne entière.
   *
   * Une seule vérité par information : « vu » et « favori » chez Jellyfin, qui les tient déjà pour
   * ses propres applications, et « à voir » dans la liste locale, qui est une intention que
   * Jellyfin ne connaît pas.
   */
  const { watched, known: watchedKnown, busy: watchedBusy, toggleWatched } = useJellyfinItemState(item.jellyfinItemId, isSeries ? "series" : "movie");
  const inList = addedStatus === "to_watch";

  const [logoErrored, setLogoErrored] = useState(false);
  const [backdropFailed, setBackdropFailed] = useState(false);
  const seasons = useMemo(() => episodesData?.seasons ?? [], [episodesData]);
  // Ce qui manque à la série — pour Sonarr, pas pour Jellyseerr : la série est là, ce sont des
  // fichiers qui manquent. Voir CinemaMissingEpisodes.
  const missing = usePlayerSeriesRequests(isSeries ? (item as { sonarrId?: number }).sonarrId : null);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);

  // Les deux listes réunies : une saison entière absente n'existe pas côté Jellyfin, et n'avait
  // donc aucune pastille — on voyait quatre saisons d'une série qui en compte cinq.
  const seasonNumbers = useMemo(() => {
    const all = new Set<number>(seasons.map((s) => s.seasonNumber));
    for (const s of missing.seasons) all.add(s.seasonNumber);
    // Les spéciaux en dernier — voir `orderSeasons`.
    return orderSeasons(all);
  }, [seasons, missing.seasons]);

  const activeSeason = selectedSeason ?? defaultSeason(seasonNumbers);
  const episodes = seasons.find((s) => s.seasonNumber === activeSeason)?.episodes ?? [];

  // Escape still closes on the mobile layout — a hardware/bluetooth keyboard on a tablet, and
  // desktop browsers emulating a phone viewport, both reach this screen.
  // Et rien non plus tant que le lecteur occupe l'écran : cette fiche reste montée dessous, et
  // Échap refermait le lecteur *et* elle — voir `playerHoldsKeyboard`, que les fiches du bureau
  // partagent.
  const playerOwnsKeyboard = playerHoldsKeyboard(playback);
  useEffect(() => {
    // La fiche du dessous n'écoute rien : deux écouteurs pour la même touche fermeraient les
    // deux d'un coup, ce qui remonterait de deux crans dans l'historique.
    if (inert || playerOwnsKeyboard) return;
    function onKey(e: KeyboardEvent) {
      if (showTrailer) return;
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, showTrailer, inert, playerOwnsKeyboard]);

  // Deliberately stays open underneath the player: dismissing the player should land back on
  // the sheet you started from, not on the browse grid behind it.

  const nextEpisode = episodesData?.nextEpisode;
  /**
   * Ce que Lire lance et ce qu'il annonce : ce que le serveur a dit, sinon ce que « Reprendre » et
   * « À suivre », gardés sur l'appareil, savent déjà — la même décision que les deux fiches du
   * bureau, dans `sheetFacts.ts`.
   */
  const facts = useSheetPlayFacts(
    isSeries
      ? { kind: "series", jellyfinItemId: item.jellyfinItemId, sonarrId: (item as CinemaSeries).sonarrId }
      : { kind: "movie", jellyfinItemId: item.jellyfinItemId },
    item.title,
    isSeries
      ? episodesData
        ? { kind: "series", known: true, episode: episodesData.nextEpisode }
        : undefined
      : progress
        ? { kind: "movie", known: progress?.known === true, resumeTicks: progress.resumeTicks, runtimeTicks: progress.runtimeTicks }
        : undefined
  );
  const resumeTicks = facts.resumeTicks;
  /**
   * Sait-on s'il y a une reprise, ou attend-on encore la réponse ?
   *
   * `resumeTicks` vaut `null` dans les deux cas, et les confondre faisait repartir du début un
   * film vu à moitié quand on cliquait sur une page fraîchement chargée. Voir `resumeKnown` dans
   * PlayButton — c'est le même jumeau, il doit dire la même chose.
   */
  // Pour un film, « la réponse est arrivée » ne suffit pas : la route revient avec `known: false`
  // quand Jellyfin n'a pas répondu, et ce silence se lisait « aucune reprise » — voir
  // `resumeAtFor`.
  const resumeKnown = facts.resumeKnown;
  const runtimeTicks = facts.runtimeTicks;
  const hasResume = facts.hasResume;
  const playTargetId = facts.targetId;
  const playTargetTitle = facts.title;
  // Grisé seulement si Jellyfin a répondu que le fichier n'existe plus — voir `missingFiles.ts`.
  const fileMissing = useFileMissing(playTargetId);
  // La place du bouton est tenue tant qu'on ne sait ni si la lecture est ouverte, ni — pour une
  // série jamais commencée — quel épisode elle lancerait.
  const playPending =
    playerEnabled === undefined || (!playTargetId && isSeries && episodesData === undefined && episodesError === undefined);
  // Ce que Lire va demander, demandé dès l'ouverture de la fiche — voir `usePlaybackPrefetch`.
  // Le titre du bouton principal seulement — le film, ou l'épisode à reprendre —, pas chaque
  // ligne d'épisode.
  usePlaybackPrefetch(playTargetId);

  // Flat (season, episode) order — powers the player's own credits-time auto-advance, same
  // contract PlayButton/PlayerHost already expect on desktop.
  // Relu à l'appel, pas figé au rendu : voir `useNextEpisodeFromCache`.
  const getNextEpisode = useNextEpisodeFromCache(`/api/cinema/series/${item.jellyfinItemId}/episodes`);

  function play(fromStart = false) {
    if (!playTargetId || fileMissing) return;
    playback.play({
      itemId: playTargetId,
      title: playTargetTitle,
      // « Recommencer » dit toujours zéro. Sinon : la position si on la connaît, zéro si on sait
      // qu'il n'y en a pas, et rien du tout tant qu'on l'ignore — auquel cas c'est le serveur qui
      // tranche, ce qui vaut mieux qu'une affirmation fausse. Voir PlaybackSession.
      resumeAt: resumeAtFor({ fromStart, known: resumeKnown, resumeTicks }),
      ...(isSeries ? { getNextEpisode } : {}),
    });
  }

  function playEpisode(episode: CinemaEpisode) {
    playback.play({
      itemId: episode.jellyfinItemId,
      title: episode.title,
      resumeAt: episode.resumeTicks ? episode.resumeTicks / 10_000_000 : 0,
      getNextEpisode,
    });
  }

  function toggleInList() {
    // Le bouton n'est pas rendu sans identifiant TMDB (voir `canJoinWatchlist`) ; la garde reste,
    // pour qu'aucun chemin ne renvoie le `0` que la route refusait d'un 400.
    if (!canJoinWatchlist(tmdbId)) return;
    if (inList) removeFromWatchlist({ tmdbId, mediaType: isSeries ? "series" : "movie" });
    else
      addToWatchlist(
        { tmdbId, mediaType: isSeries ? "series" : "movie", title: item.title, year: item.year, posterPath: item.posterUrl, voteAverage: null },
        "to_watch"
      );
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      // The entrance animation is dropped from the first touch onwards, not just while the
      // finger is down: it animates the same transform this does (a running animation beats an
      // inline style, so the sheet wouldn't follow the finger at all), and letting it back in on
      // release made the sheet replay its whole entrance every time a drag sprang back — which
      // is what the "weird animation on release" was.
      // La classe d'animation ne dépend pas de `inert`, et c'est délibéré.
      //
      // Elle en dépendait, et c'était le « micro rechargement » : une fiche recouverte perdait sa
      // classe d'entrée, la retrouvait en redevenant celle du dessus, et le navigateur rejouait
      // donc l'animation — une fiche qui n'avait jamais été fermée se remettait à s'ouvrir. En la
      // laissant en place, rien ne change au moment où la carte du dessus s'en va : l'animation a
      // déjà eu lieu, il y a longtemps, et sa classe ne bouge plus.
      //
      // Une fiche recouverte ne peut de toute façon être ni tirée ni fermée — ses gestes sont
      // débranchés —, donc les deux autres branches restent fausses pour elle.
      className={`phone-sheet-frame safe-x fixed inset-x-0 overflow-y-auto overscroll-contain bg-ink ring-1 ring-white/10 ${
        sheetMotionClass({ swipe, leaving: closing, revealed, out: swapsInPlace ? "" : "sheet-out" })
      }`}
      // Starts the artwork below the status bar rather than behind it: iOS dims and blurs that
      // strip in a standalone PWA, so a full-bleed image there just comes out muddy and the close
      // button lands in the murk. Since 26/09/2026 the whole card starts there (`phone-sheet-frame`),
      // half a rem lower, rounded and edged like the person sheet — no longer a padding inside a
      // rectangle glued to the top of the screen.
      style={{
        // Les plans, de bas en haut : la grille (45), les panneaux du rail (46) — qu'une fiche
        // recouvre sans les refermer —, la fiche du dessous (47) et celle du dessus (48).
        zIndex: inert ? 47 : 48,
        // Inerte : elle ne fait que se laisser voir. Sans ça, le doigt qui tire la fiche du dessus
        // finirait par la traverser et atteindre celle d'en dessous.
        // Et pendant sa propre sortie (règle 2 des fiches) : un appui sur un titre similaire au
        // milieu de l'animation empilait une fiche par-dessus, et celle-ci, devenue « dessous »,
        // ne se refermait plus jamais — invisible, mais toujours dans l'adresse (23/09/2026).
        pointerEvents: inert || closing ? "none" : undefined,
        transform: !inert && swipe.touched ? `translateY(${swipe.offset}px)` : undefined,
        // No transition while the finger is down: the sheet is not animating towards the finger,
        // it is where the finger is. On release the spring back (or the rest of the way out) is
        // what gets eased.
        transition: swipe.dragging
          ? "none"
          : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 200ms ease-out",
        // Stays fully opaque on the way down — fading it turned the gesture into a screen effect
        // you could see the grid through. It's one solid panel being moved out of the way, so it
        // gets the two things a panel gets when it lifts off the screen edge: corners and a
        // shadow, both proportional to how far it has come.
        borderTopLeftRadius: phoneSheetCorner(swipe.offset),
        borderTopRightRadius: phoneSheetCorner(swipe.offset),
        boxShadow: swipe.offset > 0 ? "0 -18px 50px rgba(0,0,0,0.55)" : undefined,
      }}
    >
      {/* 16:9 header image, bleeding into the page under a gradient rather than ending on a hard
          edge — the same treatment the desktop sheet uses, scaled to a phone. */}
      <div
        className="relative aspect-video w-full"
        {...(inert ? {} : swipe.handlers)}
        // touch-action none: the browser must not claim this gesture for its own scrolling, or
        // it steals the pointer stream halfway through the drag. Only this block gives that up —
        // the rest of the sheet scrolls natively.
        //
        // maxHeight : téléphone couché, une bannière en 16:9 pleine largeur fait 475 px de haut
        // pour 400 px de fenêtre. On arrivait donc sur une image qui remplissait tout l'écran, et
        // il fallait défiler pour découvrir qu'il y avait un titre et des boutons dessous.
        style={{ touchAction: "none", maxHeight: "52svh" }}
      >
        {/* Un échec de chargement retombe sur le fond uni, comme une absence d'image.
            Sans cela le navigateur dessinait sa propre vignette d'image cassée — un « ? » en
            plein milieu de la bannière, ce qu'on voyait sur les fiches de séries dont le visuel
            manque. */}
        {item.backdropUrl && !backdropFailed ? (
          <FadeInImg
            src={item.backdropUrl}
            alt=""
            onError={() => setBackdropFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-surface" />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-ink via-ink/20 to-transparent" />
        <button
          type="button"
          {...NOT_THE_HANDLE}
          onClick={requestClose}
          aria-label={t("cinema.back")}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-inset ring-white/12 active:scale-95"
        >
          <X size={18} />
        </button>
      </div>

      {/* Couché, l'écran fait ~844 px de large : des boutons pleine largeur y traversent tout
          l'écran et le texte court sur des lignes trop longues. Une colonne centrée règle les
          deux, sans changer quoi que ce soit debout. */}
      {/* `relative` : ce bloc remonte de 24 px sous la bannière, et la bannière est positionnée.
          Un élément positionné se peint après les blocs statiques quel que soit l'ordre du
          document : le dégradé opaque du bas de l'image recouvrait donc le titre, dont il ne
          restait qu'un liseré de six pixels. Positionner ce bloc à son tour le remet au-dessus,
          à sa place — le chevauchement lui-même est voulu, c'est ce qui pose le titre dans le
          fondu de l'image. */}
      <div className={`relative -mt-6 px-4 pb-16 ${short ? "mx-auto w-full max-w-xl" : ""}`}>
        {item.logoUrl && !logoErrored ? (
          <CinemaLogo src={item.logoUrl} alt={item.title} surface="phone" onError={() => setLogoErrored(true)} className="mb-3 object-left" />
        ) : (
          <h1 className="mb-3 text-2xl font-bold leading-tight text-white font-display">{item.title}</h1>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>{item.year}</span>
          {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
          {isSeries && seasons.length > 0 && (
            <span>{t("cinema.seasonCount", { n: seasons.length })}</span>
          )}
          {/* La durée, à côté de l'année et du genre : c'est la troisième chose qu'on veut savoir
              avant de lancer un film. Pour une série, celle d'un épisode (« 45min/ép. ») — ce
              qu'engage le premier, avant d'en avoir ouvert aucun (21/09/2026). */}
          {/* Celle du catalogue d'abord, là dès l'ouverture — celui des séries n'en a pas, et la
              leur s'insère en fondu. */}
          {runtimeLabel(isSeries ? info?.tmdb?.runtime : sheetRuntimeMinutes((item as CinemaMovie).runtimeMinutes, info?.tmdb?.runtime), isSeries) && (
            <span className={isSeries ? late.fade : ""}>
              {runtimeLabel(isSeries ? info?.tmdb?.runtime : sheetRuntimeMinutes((item as CinemaMovie).runtimeMinutes, info?.tmdb?.runtime), isSeries)}
            </span>
          )}
          <QualityBadges quality={"quality" in item ? item.quality : undefined} />
          {item.genres.length > 0 && <span className="truncate">{item.genres.slice(0, 3).map((g) => genreLabel(g, t)).join(" · ")}</span>}
        </div>

        {playPending && (
          <div
            aria-hidden="true"
            data-sheet-reserved=""
            className="invisible mb-2 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-base font-semibold"
          >
            <Play size={18} />
            {t("common.play")}
          </div>
        )}
        {!playPending && playerEnabled && playTargetId && (
          <button
            type="button"
            onClick={() => play()}
            disabled={fileMissing}
            data-play-unavailable={fileMissing ? "" : undefined}
            className={`mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-base font-semibold text-ink transition-transform ${
              fileMissing ? "cursor-not-allowed opacity-45" : "active:scale-95"
            }`}
          >
            <Play size={18} fill="currentColor" />
            {fileMissing
              ? t("cinema.fileMissing")
              : formatContinueLabel(t, resumeTicks, runtimeTicks, facts.seasonNumber, facts.episodeNumber, facts.rewatch)}
          </button>
        )}

        {!playPending && playerEnabled && playTargetId && hasResume && !fileMissing && (
          <button
            type="button"
            onClick={() => play(true)}
            className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white transition-transform active:scale-95"
          >
            <RotateCcw size={16} />
            {t("cinema.restartFromBeginning")}
          </button>
        )}

        {late.pending && <ReservedLine className="mb-4 h-[2.75rem]" />}
        {info?.trailerKey && (
          <button
            type="button"
            onClick={() => setShowTrailer(true)}
            className={`mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white transition-transform active:scale-95 ${late.fade}`}
          >
            <Video size={16} />
            {t("cinema.trailer")}
          </button>
        )}

        {/* Avec le synopsis plutôt qu'avec l'année : placée plus haut, elle repoussait « Lire ». */}
        {late.pending ? (
          <ReservedLine className="mb-1.5 h-[1.1rem]" />
        ) : (
          <CinemaTagline text={info?.tmdb?.tagline} className={`mb-1.5 ${late.fade}`} />
        )}
        {/* Le synopsis du catalogue ne change pas de texte à l'arrivée de TMDB — voir `sheetOverview`. */}
        <p className="mb-3 text-sm leading-6 text-white">{sheetOverview(item.overview, info?.tmdb?.overview)}</p>


        {/* Netflix's icon-over-label action row — big touch targets, no text buttons competing
            with the primary white one above. */}
        <div className="mb-6 flex items-start gap-8">
          {/* Deux coches identiques côte à côte, dont l'une servait à la fois d'« ajouter » et
              d'« ajouté » : rien ne distinguait les deux boutons ni les deux états. Un plus qui
              devient un marque-page coché se lit d'un coup d'œil, et le libellé dit l'état. */}
          {canJoinWatchlist(tmdbId) && (
            <button type="button" onClick={toggleInList} aria-pressed={inList} className="flex w-16 flex-col items-center gap-1.5 active:scale-95">
              <ToggleGlyph on={inList} onIcon={<BookmarkCheck size={22} className="text-accent-400" />} offIcon={<Plus size={22} className="text-white" />} />
              <span className="text-center text-xs leading-tight text-muted">
                {inList ? t("cinema.inMyList") : t("watchlist.statuses.toWatch")}
              </span>
            </button>
          )}
          {/* Estompé tant qu'on ignore l'état : proposer « marquer comme vu » sans l'avoir lu,
              c'est proposer d'écrire une valeur qu'on a devinée. */}
          <button
            type="button"
            onClick={toggleWatched}
            disabled={watchedBusy}
            aria-pressed={watched}
            className={`flex w-16 flex-col items-center gap-1.5 active:scale-95 ${watchedKnown ? "" : "opacity-40"}`}
          >
            <ToggleGlyph on={watched} onIcon={<CircleCheck size={22} className="text-accent-400" />} offIcon={<Check size={22} className="text-white" />} />
            <span className="text-center text-xs leading-tight text-muted">
              {watched ? t("cinema.watchedState") : t("cinema.markWatched")}
            </span>
          </button>
        </div>

        {/* Des visages plutôt qu'une ligne de noms : chacun ouvre la fiche de la personne, posée
            par-dessus ce titre. Juste après les actions — plus bas, sous la liste des épisodes
            d'une série, personne ne l'aurait trouvé. Voir `CinemaCastRow`. */}
        {/* La même rangée, invisible, tient exactement sa hauteur tant que la réponse n'est pas là. */}
        {late.pending && (
          <div aria-hidden="true" data-sheet-reserved="" className="invisible -mx-4 mb-4 px-4">
            <CinemaCastRow cast={RESERVED_CAST} />
          </div>
        )}
        {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
          <div className={`-mx-4 mb-4 px-4 ${late.fade}`}>
            <CinemaCastRow cast={info.tmdb.cast} />
          </div>
        )}

        {isSeries && seasonNumbers.length > 0 && (
          <>
            {/* Horizontal season pills rather than Netflix's dropdown: same job, one tap instead
                of two, and no popover to position/dismiss on a small screen. */}
            {seasonNumbers.length > 1 && (
              <div className="scrollbar-thin -mx-4 mb-3 flex gap-2 overflow-x-auto px-4">
                {seasonNumbers.map((seasonNumber) => {
                  const active = seasonNumber === activeSeason;
                  const gap = missingCount(missing.seasonOf(seasonNumber));
                  return (
                    <button
                      key={seasonNumber}
                      type="button"
                      onClick={() => setSelectedSeason(seasonNumber)}
                      className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-sm transition-colors ${
                        active ? "bg-white text-ink font-medium" : "bg-white/10 text-muted"
                      }`}
                    >
                      {seasonNumber === 0 ? t("cinema.specials") : t("cinema.season", { n: seasonNumber })}
                      {/* Ce qui manque, dit sur la pastille elle-même : c'est ce qu'on cherche en
                          parcourant cette rangée. */}
                      {gap > 0 && (
                        <span className={`tabular-nums text-[11px] ${active ? "text-ink/50" : "text-subtle"}`}>
                          {gap}
                        </span>
                      )}
                      {active && <ChevronDown size={14} />}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="space-y-4">
              {episodes.map((episode) => (
                <button
                  key={episode.jellyfinItemId}
                  type="button"
                  onClick={() => playEpisode(episode)}
                  // Une ligne pleine largeur s'allume, elle ne s'enfonce pas : à 0,95 elle glissait
                  // d'une quinzaine de pixels sous le doigt — voir `pressable` dans globals.css.
                  // `active:transform-none` écarte aussi l'enfoncement de base des boutons.
                  className="flex w-full gap-3 rounded-lg text-left transition-colors active:transform-none active:bg-white/10 active:delay-75"
                >
                  <div className="relative w-32 shrink-0">
                    <PosterImage src={episode.thumbnailUrl} alt={episode.title} aspectRatio="aspect-video" unoptimized subtle />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white">
                        <Play size={14} fill="currentColor" />
                      </span>
                    </span>
                    {episode.watched && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent-500/90">
                        <Check size={10} className="text-white" />
                      </span>
                    )}
                    <CinemaEpisodeProgress
                      resumeTicks={episode.resumeTicks}
                      runtimeTicks={episode.runtimeTicks}
                      watched={episode.watched}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white">
                      {episode.episodeNumber}. {episode.title}
                      {episode.jellyfinItemId === nextEpisode?.itemId && (
                        <span className="ml-2 rounded-full bg-accent-600/25 px-2 py-0.5 text-xs font-medium text-accent-400">
                          {t("cinema.nextUpBadge")}
                        </span>
                      )}
                    </p>
                    {/* Remaining time on a started episode, runtime otherwise — same rule as the
                        desktop season browser. */}
                    {episode.resumeTicks && episode.runtimeTicks && !episode.watched ? (
                      <p className="mt-0.5 text-xs text-accent-400">
                        {t("cinema.timeRemaining", { time: formatDurationShort(episode.runtimeTicks - episode.resumeTicks) })}
                      </p>
                    ) : (
                      episode.runtimeMinutes && (
                        <p className="mt-0.5 text-xs text-subtle">{formatMinutes(episode.runtimeMinutes)}</p>
                      )
                    )}
                    {episode.overview && <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted">{episode.overview}</p>}
                  </div>
                </button>
              ))}
            </div>

            <CinemaMissingEpisodes
              season={activeSeason !== null ? missing.seasonOf(activeSeason) : undefined}
            />
          </>
        )}

        {/* La saga d'abord, les titres similaires ensuite : « et la suite ? » est une question
            plus précise que « et quoi d'autre ? », et elle se pose plus souvent. */}
        {mediaType === "movies" && "radarrId" in item && (
          /* `onSelectOwned` est le rappel des titres similaires, volontairement : les deux rangées
             ouvrent une fiche de la même façon, et se referment donc de la même façon. */
          <CinemaMovieCollectionRow radarrId={item.radarrId} onSelectOwned={onSelectSimilar} className="mt-8" />
        )}
        {/* `mt-8` : collées à ce qui précède, ces rangées suivaient les épisodes à venir sans le
            moindre écart (relevé le 23/09/2026). La fiche du bureau espace ses blocs elle-même. */}
        {onSelectSimilar && <CinemaSimilarRow items={similar} onSelect={onSelectSimilar} className="mt-8" />}
      </div>

      {showTrailer && info?.trailerKey && (
        <TrailerModal youtubeKey={info.trailerKey} title={item.title} onClose={() => setShowTrailer(false)} />
      )}
    </div>,
    document.body
  );
}

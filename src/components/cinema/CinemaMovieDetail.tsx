"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { ArrowLeft, BookmarkCheck, Check, CircleCheck, Heart, Plus, RotateCcw, Video } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { formatMinutes } from "@/lib/format";
import { formatContinueLabel } from "@/lib/cinemaContinueLabel";
import { ImdbBadge } from "@/components/ImdbBadge";
import { CinemaSimilarRow, useCinemaSimilar, similarRowKeyNav } from "@/components/cinema/CinemaSimilarRow";
import { CinemaCollectionRow, useCinemaCollection } from "@/components/cinema/CinemaCollectionRow";
import { CinemaScrollHint } from "@/components/cinema/CinemaScrollHint";
import { PlayButton } from "@/components/PlayButton";
import { usePlayback } from "@/components/PlaybackProvider";
import { usePlayerEnabled } from "@/lib/usePlayerEnabled";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useWatchlistStatusMap } from "@/lib/useWatchlistStatusMap";
import { cinemaNavigate, useSheetBehind, arrivedByBack } from "@/lib/cinemaRoute";
import { useDelayedClose } from "@/lib/useDelayedClose";
import { useJellyfinItemState } from "@/lib/useJellyfinItemState";
import { useT } from "@/components/TranslationProvider";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, MENU_BADGE_ACTIVE, focusFirstAction } from "@/components/cinema/detailMenu";
import { HORIZONTAL_VEIL, VERTICAL_VEIL, COLUMN_STYLE, MENU_STYLE, SECTION_CLASS, CAST_CLASS, COLUMN_GAP, CinemaOverview, CinemaSynopsisModal } from "@/components/cinema/CinemaDetailLayout";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";

const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });


interface RadarrCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

interface RadarrInfo {
  /** `runtime` est la durée du film en minutes : elle vient de TMDB, comme le synopsis. */
  tmdb: { overview: string; cast: RadarrCastMember[]; runtime?: number | null } | null;
  trailerKey: string | null;
}

// "The banner opened big" — click/Enter on a card (or the hero) escalates from CinemaHero's
// passive preview into this: a full-screen, ONLY-this-on-screen detail à la Netflix's TV app.
// The backdrop fills the entire screen and stays crisp everywhere EXCEPT a soft backdrop-blur
// zone behind the bottom third (where the menu sits) — the earlier version blurred the whole
// image, which just looked broken instead of ambient. Only the button column is narrow — the
// title/synopsis/cast get the full text column width so the title doesn't wrap onto 3 lines.
// Portaled to document.body for the same reason CinemaClient's own fixed layers are (see its doc
// comment): PageTransition's lingering transform breaks `position: fixed` otherwise.
export function CinemaMovieDetail({
  item,
  onClose,
  onSelectSimilar,
  /**
   * Cette fiche est recouverte par une autre.
   *
   * Elle reste montée, avec ses données et son défilement, pour qu'un retour la retrouve intacte
   * plutôt que de la reconstruire — c'est ce qui faisait recharger la rangée « Titres similaires »
   * en revenant du titre qu'on venait d'y ouvrir. Dessous, elle ne prend ni le clavier ni le
   * focus : deux fiches montées ensemble écoutent Échap toutes les deux, et celle du dessous
   * ramenait le focus sur son propre menu à chaque flèche.
   */
  underneath = false,
}: {
  item: CinemaMovie;
  onClose: () => void;
  // Lets the "Titres similaires" row swap this sheet's subject for another title, rather than
  // stacking a second sheet on top of the first.
  onSelectSimilar?: (item: CinemaMovie) => void;
  underneath?: boolean;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  /** Vrai dès que le spectateur a lui-même déplacé le focus — voir l'effet plus bas. */
  const userMovedFocus = useRef(false);

  const [showTrailer, setShowTrailer] = useState(false);
  const [showSynopsis, setShowSynopsis] = useState(false);
  const { data: info } = useSWR<RadarrInfo>(`/api/radarr/movies/${item.radarrId}/info`, fetcher);
  // CinemaMovie (the /api/cinema/movies payload) carries no per-user watch progress at all
  // (Radarr/TMDB fields only, shared across every viewer) — without this, Lecture always started
  // a partly-watched movie over from 0 unless the movie happened to be opened via the Continue
  // Watching row instead (a different endpoint, with its own resume point already attached).
  //
  // La même réponse porte « vu » et « favori », qui vivent chez Jellyfin et non dans la base
  // locale — voir useJellyfinItemState pour pourquoi une seconde copie finissait toujours par
  // mentir.
  const { progress, watched, favorite, known: flagsKnown, busy: flagsBusy, toggleWatched, toggleFavorite } =
    useJellyfinItemState(item.jellyfinItemId);
  const hasResume = !!progress?.resumeTicks && progress.resumeTicks > 0;
  // Without this, Vu/À voir always opened looking un-toggled even for a title already on the
  // watchlist — useAddToWatchlist only reflects whatever status is handed to it as initialStatus
  // (see its own doc comment), and nothing was passing one here, unlike every other surface that
  // uses this hook (PosterCard, recommendations).
  const statusMap = useWatchlistStatusMap([{ mediaType: "movie", tmdbId: item.tmdbId }]);
  const { addedStatus, addToWatchlist, removeFromWatchlist } = useAddToWatchlist(statusMap[`movie:${item.tmdbId}`] ?? null);
  // item.logoUrl comes bulk-included in the /api/cinema/movies payload now (see CinemaHero's own
  // note) — known synchronously, prefetched alongside backdrops by CinemaClient's warm-up
  // effect. This component remounts fresh per item (a new instance each time selectedItem
  // changes), so no reset-on-change needed the way CinemaHero requires.
  const [logoErrored, setLogoErrored] = useState(false);

  // Keeps this overlay mounted for one exit animation's worth of time after a close is
  // requested, instead of vanishing the instant onClose fires — see the hook's own doc comment.
  // Every close trigger below (Escape/Backspace, the back button, the auto-close-on-play effect)
  // calls requestClose() instead of onClose directly now.
  // Pas d'animation de sortie quand c'est une autre fiche qui attend derrière : la sortie
  // découvrirait l'accueil deux dixièmes de seconde avant que la précédente n'entre par-dessus.
  // Voir `useSheetBehind`.
  // Monté parce qu'on revient dessus, et non parce qu'on l'ouvre : pas d'animation d'entrée. Il
  // n'ouvre rien, il se découvre — voir `arrivedByBack`. Lu une seule fois, au montage.
  const [revealed] = useState(() => arrivedByBack());
  const sheetBehind = useSheetBehind();
  const { closing, requestClose } = useDelayedClose(onClose, sheetBehind ? 0 : 220);

  // Drives both the second snap section and the chevron pointing at it: with nothing similar in
  // the library there's no second screen, so neither should exist.
  const similar = useCinemaSimilar(item, "movies");
  const collection = useCinemaCollection(item.radarrId);
  const hasSimilar = !!onSelectSimilar && similar.length > 0;

  // Lands focus on the first menu row as soon as the overlay opens — a TV remote user should
  // never need to press Down before Play is reachable. PlayButton itself only renders once
  // usePlayerEnabled() resolves (it starts false while /api/config/public is in flight, same
  // hook, separate call here) — on a mount that lands before that resolves, this ran once,
  // found no Play row yet, and focused Bande-annonce instead: a click/Enter right after opening
  // played the trailer instead of the film. Re-running once playerEnabled flips true (and once
  // trailerKey is known, which can also reorder what's "first") re-targets focus at whichever
  // row is now actually first, catching that race instead of freezing on its initial guess.
  // Un titre similaire rouvre la même fiche sur un autre film : c'est une arrivée, et le
  // drapeau doit repartir de zéro. Sans cela, un spectateur venu d'un titre similaire — donc
  // ayant forcément bougé le focus pour l'atteindre — n'était plus jamais ramené sur la lecture.
  // Déclaré avant l'effet de focus : les effets s'exécutent dans leur ordre de déclaration.
  useEffect(() => {
    userMovedFocus.current = false;
  }, [item.radarrId]);

  const playerEnabled = usePlayerEnabled();
  useEffect(() => {
    /**
     * Le premier passage a lieu avant que `usePlayerEnabled` ait répondu, donc avant que la
     * ligne de lecture existe : le focus tombe alors sur « Recommencer » ou « Bande-annonce »,
     * et l'effet est rejoué pour le rattraper une fois la ligne apparue.
     *
     * La garde ne peut donc pas être « quelqu'un a déjà le focus dans le menu » — c'est vrai
     * précisément dans le cas qu'il s'agit de rattraper, et la correction ne se faisait jamais.
     * Elle est « quelqu'un a bougé lui-même » : tant que personne n'a touché aux flèches ni
     * cliqué, la première ligne reste la bonne cible.
     */
    const frame = requestAnimationFrame(() => {
      if (underneath || userMovedFocus.current) return;
      focusFirstAction(containerRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [playerEnabled, info?.trailerKey, item.radarrId, underneath]);

  // Stays open underneath the player instead of closing when Lecture starts, so dismissing the
  // player lands you back on the sheet you started from rather than on the browse grid. What
  // originally forced the close was this component's own Up/Down handler fighting
  // PlayerControls' for the keyboard — every arrow press ran here too, found the player's
  // focused control wasn't one of ITS [data-detail-menu] buttons, and yanked focus back to
  // Lecture. The handler now stands down while the player is full-screen instead, and takes the
  // keyboard back (and the focus with it) the moment the player is gone.
  const playback = usePlayback();
  const playerOwnsKeyboard = playback.mode === "full";
  const wasPlayerFullScreen = useRef(playerOwnsKeyboard);
  useEffect(() => {
    if (!underneath && wasPlayerFullScreen.current && !playerOwnsKeyboard) {
      focusFirstAction(containerRef.current);
    }
    wasPlayerFullScreen.current = playerOwnsKeyboard;
  }, [playerOwnsKeyboard, underneath]);

  useEffect(() => {
    if (underneath) return;
    function onKey(e: KeyboardEvent) {
      // The player is on top and owns the keyboard — see above.
      if (playerOwnsKeyboard) return;
      // TrailerModal has its own Escape handler (also on window) that closes just itself —
      // without this guard, Escape while the trailer is open closed BOTH it and this whole
      // detail overlay at once, since nothing stops this listener from also firing on the same
      // keypress.
      if (showTrailer || showSynopsis) return;
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        requestClose();
        return;
      }
      // The similar-titles row below the menu takes the arrow keys when focus is in it (and
      // claims the Down that enters it from the last menu row) — see similarRowKeyNav.
      if (similarRowKeyNav(e, containerRef.current)) return;

      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      userMovedFocus.current = true;
      const rows = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>("[data-detail-menu]") ?? []);
      if (rows.length === 0) return;
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown") rows[Math.min(idx + 1, rows.length - 1)]?.focus();
      else rows[Math.max(idx - 1, 0)]?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, showTrailer, showSynopsis, playerOwnsKeyboard, underneath]);

  // « À voir » reste local : c'est une intention, et rien d'autre ne la connaît. « Vu » et
  // « Favori » sont partis chez Jellyfin (voir plus haut). Un titre peut donc être à la fois dans
  // la liste et marqué vu, ce que l'ancien schéma — un seul statut par titre — interdisait.
  function toggleAddToList() {
    if (inList) removeFromWatchlist({ tmdbId: item.tmdbId, mediaType: "movie" });
    else
      addToWatchlist(
        { tmdbId: item.tmdbId, mediaType: "movie", title: item.title, year: item.year, posterPath: item.posterUrl, voteAverage: null },
        "to_watch"
      );
  }

  if (typeof document === "undefined") return null;

  const inList = addedStatus === "to_watch";

  return createPortal(
    // z-index as inline style, not a Tailwind class — arbitrary-value classes weren't making it
    // into the production CSS bundle (see CinemaClient's own note). Just above CinemaClient's own
    // z-45 browse layer, both still well below PlayerHost's z-80 — pressing Lecture needs the
    // player to end up on TOP of this, not hidden behind it (see CinemaClient's z-index note).
    <div
      ref={containerRef}
      className={`fixed inset-0 overflow-hidden bg-ink ${closing ? "animate-fade-out" : revealed ? "" : "animate-fade-in"}`}
      // Le rail du lecteur est posé sur le bord gauche de l'écran, au-dessus de cette fiche :
      // sans ce retrait, la colonne de texte et le bouton Retour passeraient dessous. La variable
      // vaut 0 partout ailleurs, donc rien ne bouge hors du lecteur.
      inert={underneath}
      aria-hidden={underneath || undefined}
      style={{ zIndex: 47, paddingLeft: "var(--player-rail, 0px)" }}
    >
      {item.backdropUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.backdropUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
      {/* Localized, gradually-eased blur — not a global filter on the image, and not a flat
          rectangle either (a plain backdrop-blur-md div has a hard visible seam where it starts,
          which is what looked broken here). backdrop-blur blurs whatever renders behind THIS div
          (the sharp img above); the mask ramps that blur in from nothing to full over the top
          half of the div instead of switching on all at once, and the whole zone sits low and
          short — only behind the synopsis/menu, not across the middle of the image. */}
      <div
        className="absolute inset-x-0 bottom-0 backdrop-blur-md"
        style={{
          height: "45%",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
        }}
      />
      {/* Deux voiles à étapes explicites plutôt qu'un dégradé en trois arrêts : voir
          CinemaDetailLayout, où la raison de chaque pourcentage est écrite. */}
      <div className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
      <div className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />

      {/* z-10, explicitly above the content column below: that column spans the full height
          (flex items-center, for vertical centering) and — even with a transparent background —
          would otherwise sit on top of this button in DOM/paint order and silently eat every
          mouse click aimed at it, leaving only the Escape/Backspace keyboard path working. */}
      <button
        onClick={requestClose}
        className="btn btn-ghost fixed z-10 rounded-full bg-black/55 px-3 py-2"
        style={{ top: "max(1rem, env(safe-area-inset-top))", left: "calc(1rem + var(--player-rail, 0px))" }}
      >
        <ArrowLeft size={16} /> {t("cinema.back")}
      </button>

      {/* Two snap positions, like the browse screen: the title block, then the similar titles.
          Each section is min-h-full so it fills the viewport on its own, which is what stops the
          scroll from ever resting halfway between the two.

          justify-end inside a min-h-full section, NOT items-end on the scroller: a flex container
          aligned to its end edge clips whatever overflows past its START edge and makes it
          unreachable by scrolling — that's what pushed the logo and title off the top of the
          screen when the similar row first landed here. A section that simply grows can't. */}
      <div className="scrollbar-thin relative h-full snap-y snap-mandatory overflow-y-auto scroll-smooth">
        <div data-snap-section className={SECTION_CLASS}>
        <div
          key={item.radarrId}
          style={COLUMN_STYLE}
          className={`flex flex-col ${COLUMN_GAP} px-8 sm:px-16 ${closing ? "animate-fade-out-down" : "animate-fade-in-up"}`}
        >
          {item.logoUrl && !logoErrored ? (
            <CinemaLogo
              src={item.logoUrl}
              alt={item.title}
              surface="sheet"
              onError={() => setLogoErrored(true)}
              className="mb-1"
            />
          ) : (
            <h1 className="text-2xl font-bold leading-tight text-white drop-shadow-lg sm:text-4xl font-display">{item.title}</h1>
          )}

          <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
            <span>{item.year}</span>
            {item.imdbRating && <ImdbBadge rating={item.imdbRating} size="sm" />}
            {/* Voir la note jumelle de la fiche téléphone : la durée manquait, et c'est la
                troisième chose qu'on veut savoir avant de lancer un film. */}
            {formatMinutes(info?.tmdb?.runtime) && <span>{formatMinutes(info?.tmdb?.runtime)}</span>}
            {item.genres.length > 0 && <span>{item.genres.slice(0, 3).join(" · ")}</span>}
          </div>

          <CinemaOverview
            text={info?.tmdb?.overview || item.overview || ""}
            readMore={t("cinema.readMore")}
            onOpen={() => setShowSynopsis(true)}
          />

          {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
            /* Chaque nom mène à sa fiche, sans quitter le lecteur. C'était une ligne de texte
               mort au milieu d'un écran où tout le reste s'ouvre ; et une filmographie est
               souvent la meilleure façon de trouver quoi regarder ensuite.

               Volontairement hors du parcours des flèches (pas de `data-detail-menu`) : le menu
               est une colonne d'actions, et y intercaler cinq noms ferait descendre de six crans
               pour atteindre la ligne suivante. La tabulation, elle, y va. */
            <p className={CAST_CLASS}>
              {t("cinema.cast")}{" "}
              {info.tmdb.cast.slice(0, 5).map((c, i) => (
                <span key={c.tmdbId}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    onClick={() => cinemaNavigate({ person: c.tmdbId })}
                    className="rounded transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </p>
          )}

          {/* Plus étroit que le texte au-dessus, sans être une colonne à part : deux tiers de
              la largeur du bloc — voir MENU_STYLE. */}
          <div data-detail-actions className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
            <PlayButton
              itemId={item.jellyfinItemId}
              title={item.title}
              resumeTicks={progress?.resumeTicks ?? undefined}
              runtimeTicks={progress?.runtimeTicks ?? undefined}
              variant="row"
              // Same override as CinemaSeriesDetail's own Play button — see its doc comment —
              // so a movie opened from the Continue Watching row and one opened from its own
              // poster card show the identical "Reprendre - 1h10 restants" wording.
              label={formatContinueLabel(t, progress?.resumeTicks, progress?.runtimeTicks)}
              // La même ligne que les autres : c'est le sélecteur qui se peint en blanc, pas
              // elle. Deux blancs à l'écran — un fixe et un mobile — se disputaient le sens.
              className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
            />

            {/* Only when there's actually something to restart FROM — a movie with no progress
                already opens fresh via Lecture above, so this would just be a redundant second
                "Lire" button. resumeAt deliberately omitted (not 0): PlayerHost only seeks when
                resumeAt is truthy, so leaving it out already starts at the beginning. */}
            {hasResume && (
              <button
                data-detail-menu
                onClick={() => playback.play({ itemId: item.jellyfinItemId, title: item.title })}
                className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
              >
                <span className={MENU_BADGE}>
                  <RotateCcw size={14} />
                </span>
                <span className="text-sm font-medium">{t("cinema.restartFromBeginning")}</span>
              </button>
            )}

            {info?.trailerKey && (
              <button data-detail-menu onClick={() => setShowTrailer(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
                <span className={MENU_BADGE}>
                  <Video size={14} />
                </span>
                <span className="text-sm font-medium">{t("cinema.trailer")}</span>
              </button>
            )}

            <button
              data-detail-menu
              onClick={toggleWatched}
              disabled={flagsBusy}
              aria-pressed={watched}
              // Estompé tant que Jellyfin n'a pas répondu : ce bouton écrit, et proposer d'écrire
              // une valeur qu'on n'a pas lue est la façon la plus sûre de la changer par erreur.
              className={`${MENU_ROW} ${MENU_ROW_INACTIVE} ${flagsKnown ? "" : "opacity-50"}`}
            >
              <span className={watched ? MENU_BADGE_ACTIVE : MENU_BADGE}>
                {watched ? <CircleCheck size={16} /> : <Check size={14} />}
              </span>
              <span className="text-sm font-medium">
                {watched ? t("cinema.watchedState") : t("cinema.markWatched")}
              </span>
            </button>

            {/* Le favori part chez Jellyfin, donc il se retrouve aussi sur la télé et le
                téléphone. Il n'existe que pour un titre qu'on possède — ce qui est toujours le
                cas ici, cette fiche étant celle de la bibliothèque. */}
            <button
              data-detail-menu
              onClick={toggleFavorite}
              disabled={flagsBusy}
              aria-pressed={favorite}
              className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
            >
              <span className={favorite ? MENU_BADGE_ACTIVE : MENU_BADGE}>
                <Heart size={14} />
              </span>
              <span className="text-sm font-medium">
                {favorite ? t("player.discover.favoriteOn") : t("player.discover.favorite")}
              </span>
            </button>

            {/* L'état tient dans la pastille, et non dans la ligne entière.
                Une ligne pleine d'accent criait plus fort que le repère de sélection lui-même :
                sur un menu parcouru à la télécommande, la ligne « déjà dans ma liste » avait donc
                l'air d'être celle qu'on venait de désigner. La pastille change de forme (un plus
                devient un marque-page coché) et de couleur ; la ligne, elle, reste disponible
                pour dire ce qu'elle a toujours dit : où l'on se trouve. */}
            <button
              data-detail-menu
              onClick={toggleAddToList}
              aria-pressed={inList}
              className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
            >
              <span className={inList ? MENU_BADGE_ACTIVE : MENU_BADGE}>
                {inList ? <BookmarkCheck size={16} /> : <Plus size={14} />}
              </span>
              {/* Le libellé dit l'état, pas le geste : « À voir » ne distinguait pas un titre
                  déjà enregistré d'un titre qui ne l'était pas. L'icône, elle, dit le geste. */}
              <span className="text-sm font-medium">
                {inList ? t("cinema.inMyList") : t("watchlist.statuses.toWatch")}
              </span>
            </button>
          </div>

        </div>
        {hasSimilar && <CinemaScrollHint />}
        </div>

        {/* Its own full-height snap position — centred rather than pinned to the top, so landing
            on it reads as a deliberate second screen instead of one row stranded above a lot of
            empty backdrop. */}
        {/* La saga partage la section des titres similaires plutôt que d'en réclamer une à elle :
            deux écrans pleins à faire défiler l'un après l'autre, pour deux rangées, c'est une
            promenade là où on voulait une réponse. */}
        {(hasSimilar || collection.parts.length > 0) && (
          <div data-snap-section className="flex min-h-full snap-start flex-col justify-center gap-6 px-8 sm:px-16">
            {/* Le même rappel que la rangée du dessous : ouvrir un titre de la saga et ouvrir un
                titre similaire sont le même geste, donc le même chemin — et donc, à la fermeture,
                la même animation. */}
            <CinemaCollectionRow name={collection.name} parts={collection.parts} onSelectOwned={onSelectSimilar} />
            {hasSimilar && <CinemaSimilarRow items={similar} onSelect={(next) => onSelectSimilar?.(next as CinemaMovie)} />}
          </div>
        )}
      </div>

      {showTrailer && info?.trailerKey && (
        <TrailerModal
          youtubeKey={info.trailerKey}
          title={item.title}
          onClose={() => {
            setShowTrailer(false);
            // TrailerModal doesn't restore focus itself (it wasn't built with a keyboard-nav
            // parent in mind) — without this, closing it leaves document.activeElement on
            // <body>, so this overlay's own Up/Down handler (indexOf returns -1) needs an extra,
            // wasted keypress before arrow-nav does anything again. Same class of bug already
            // fixed for the player's own menu-close case.
            requestAnimationFrame(() => focusFirstAction(containerRef.current));
          }}
        />
      )}

      {showSynopsis && (
        <CinemaSynopsisModal
          title={item.title}
          text={info?.tmdb?.overview || item.overview || ""}
          closeLabel={t("common.close")}
          onClose={() => {
            setShowSynopsis(false);
            // Rendre le focus à la ligne qui a ouvert la fenêtre, comme le fait la bande-annonce.
            requestAnimationFrame(() =>
              focusFirstAction(containerRef.current)
            );
          }}
        />
      )}
    </div>,
    document.body
  );
}

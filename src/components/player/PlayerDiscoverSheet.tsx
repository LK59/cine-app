"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { ArrowLeft, Plus, Bookmark, BookmarkCheck, Heart, Clock, CalendarClock, CircleCheck, CircleAlert, CircleSlash, Play, Users, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { cinemaClose, cinemaNavigate, openLibraryTitle, arrivedByBack } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { usePlayerTitleActions } from "@/lib/usePlayerTitleActions";
import { useIsMobile } from "@/lib/useIsMobile";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, MENU_BADGE_ACTIVE, focusFirstAction } from "@/components/cinema/detailMenu";
import {
  HORIZONTAL_VEIL,
  VERTICAL_VEIL,
  COLUMN_STYLE,
  MENU_STYLE,
  SECTION_CLASS,
  CAST_CLASS,
  COLUMN_GAP,
  CinemaOverview,
  CinemaSynopsisModal,
} from "@/components/cinema/CinemaDetailLayout";
import type { PlayerTitlePayload, PlayerTitleCast } from "@/app/api/player/title/[type]/[tmdbId]/route";
import type { PlayerRequestState } from "@/lib/playerRequestState";

const STATE_ICON: Record<PlayerRequestState, React.ElementType> = {
  unreleased: CalendarClock,
  processing: Clock,
  available: CircleCheck,
  removed: CircleSlash,
  failed: CircleAlert,
};

/**
 * La fiche d'un titre qu'on n'a pas encore.
 *
 * C'est une vraie fiche — même mise en scène, mêmes voiles, même colonne, même menu que celles
 * de la bibliothèque — et pas une fenêtre à deux boutons. La raison est concrète : la
 * filmographie d'un acteur est pleine de films qu'on ne possède pas, et si chacun est un
 * cul-de-sac, l'interface devient un mur. Ici on lit le synopsis, on regarde la distribution, on
 * navigue vers un autre acteur ; simplement, la première ligne dit « Demander » au lieu de
 * « Lire ».
 *
 * Les deux gestes restent indépendants : ajouter à une liste n'envoie rien, demander ne range
 * rien. Chacun écrit là où vit sa vérité.
 */
/**
 * La distribution, en pastilles rondes qui mènent chacune à sa fiche.
 *
 * Partagée par les deux mises en page de cette fiche — celle du grand écran et celle du
 * téléphone : c'est le même contenu, et le seul endroit d'où l'on part vers un acteur.
 */
function CastRow({
  cast,
  label,
  className = "",
}: {
  cast: PlayerTitleCast[];
  label: string;
  className?: string;
}) {
  if (cast.length === 0) return null;
  return (
    <div className={className}>
      <p className="mb-2 flex items-center gap-1.5 text-xs text-white/50">
        <Users size={12} /> {label}
      </p>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-2">
        {cast.slice(0, 12).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => cinemaNavigate({ person: c.id })}
            className="flex w-16 shrink-0 flex-col items-center gap-1.5 text-center focus-visible:outline-none"
          >
            <span className="h-16 w-16 overflow-hidden rounded-full bg-white/10 ring-1 ring-white/10">
              {c.profilePath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.profilePath} alt="" loading="lazy" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-white/30">
                  <Users size={16} />
                </span>
              )}
            </span>
            <span className="line-clamp-2 text-[10px] leading-tight text-white/70">{c.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function PlayerDiscoverSheet({
  tmdbId,
  mediaType,
  leaving = false,
}: {
  tmdbId: number;
  mediaType: "movie" | "series";
  leaving?: boolean;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const [showSynopsis, setShowSynopsis] = useState(false);

  const { data, isLoading, error } = useSWR<PlayerTitlePayload>(
    `/api/player/title/${mediaType}/${tmdbId}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const { busy, setStatus, request } = usePlayerTitleActions(
    data ? { tmdbId, type: mediaType, title: data.title, year: data.year, poster: data.poster, rating: data.rating } : null
  );

  const close = () => cinemaClose({ discover: null, person: null });
  // Le même geste que sur les fiches de la bibliothèque, qui l'avaient et pas celle-ci : on tire
  // la bannière vers le bas pour refermer.
  const swipe = useSwipeToDismiss(close);
  // Montée parce qu'on revient dessus plutôt qu'on l'ouvre : pas d'animation d'entrée — voir
  // `arrivedByBack`. Lu une seule fois, au montage.
  const [revealed] = useState(() => arrivedByBack());

  // Le focus part sur la première action, jamais sur le résumé : c'est ce qu'on est venu faire.
  //
  // Une seule fois, à l'arrivée des données. Sans le garde-fou, chaque revalidation SWR — un
  // retour sur l'onglet suffit — reprenait le focus des mains de la personne en train de lire la
  // distribution.
  const focusPlaced = useRef(false);
  useEffect(() => {
    // Seulement dans la mise en page « télécommande » : sur téléphone, on fait défiler avec le
    // doigt et un focus déplacé fait sauter la page vers le bas dès l'ouverture.
    if (isMobile || !data || focusPlaced.current) return;
    focusPlaced.current = true;
    focusFirstAction(containerRef.current);
  }, [data, isMobile]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      if (showSynopsis) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showSynopsis]);

  const inList = data?.watchlistStatus === "to_watch";
  const StateIcon = data?.requestState ? STATE_ICON[data.requestState] : Clock;

  // Même garde que les fiches du mode cinéma : ce composant peut être rendu côté serveur, où
  // `document` n'existe pas et où `createPortal` fait échouer la page entière.
  if (typeof document === "undefined") return null;


  // La fiche d'un titre absent, sur téléphone.
  //
  // Elle empruntait jusqu'ici la mise en page du grand écran — « une page tient dans un écran »,
  // colonne calée en bas. Couché, un téléphone n'a que ~390 px de haut : le titre, le synopsis et
  // les trois actions débordaient par le *haut* d'un conteneur aligné en bas, donc rognés et
  // hors d'atteinte, sans même une barre de défilement pour y aller. Et debout, elle ne
  // ressemblait à aucune autre fiche de l'application.
  //
  // Elle prend donc la forme des fiches de bibliothèque du téléphone : une bannière en haut, puis
  // tout le reste dans une colonne qui défile.
  const mobileSheet = (
    <div
      className={`app-viewport safe-x fixed inset-x-0 top-0 overflow-y-auto overscroll-contain bg-ink ${
        swipe.touched ? "" : leaving ? "animate-fade-out" : revealed ? "" : "animate-slide-up"
      }`}
      style={{
        zIndex: 47,
        paddingTop: "env(safe-area-inset-top, 0px)",
        transform: swipe.touched ? `translateY(${swipe.offset}px)` : undefined,
        // Pas de transition pendant que le doigt est posé : la fiche n'anime pas vers le doigt,
        // elle *est* où il est. C'est le relâchement qu'on adoucit — le retour en place comme le
        // reste du chemin vers le bas.
        transition: swipe.dragging
          ? "none"
          : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 200ms ease-out",
        // Opaque jusqu'au bout : la faire disparaître en fondu transformait le geste en effet
        // d'écran à travers lequel on voit la grille. C'est un panneau plein qu'on écarte, donc il
        // reçoit ce que reçoit un panneau qui décolle du bord — des coins et une ombre, l'un comme
        // l'autre proportionnels au chemin parcouru.
        borderTopLeftRadius: swipe.offset > 0 ? Math.min(28, swipe.offset * 0.5) : undefined,
        borderTopRightRadius: swipe.offset > 0 ? Math.min(28, swipe.offset * 0.5) : undefined,
        boxShadow: swipe.offset > 0 ? "0 -18px 50px rgba(0,0,0,0.55)" : undefined,
      }}
    >
      {/* Même plafond que les fiches de bibliothèque : en 16:9 pleine largeur, une bannière fait
          475 px de haut pour 390 px de fenêtre couchée — un écran entier d'image avant d'avoir
          appris qu'il y a un titre dessous. */}
      <div
        className="relative aspect-video w-full"
        {...swipe.handlers}
        // `touch-action: none` : le navigateur ne doit pas réclamer ce geste pour son propre
        // défilement, sinon il vole le flux de pointeurs au milieu du glissement. Seul ce bloc y
        // renonce ; le reste de la fiche défile normalement.
        style={{ maxHeight: "52svh", touchAction: "none" }}
      >
        {data?.backdrop ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.backdrop} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-slate-900" />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-ink via-ink/20 to-transparent" />
        <button
          type="button"
          onClick={close}
          aria-label={t("cinema.back")}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white active:scale-95"
        >
          <X size={18} />
        </button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-12">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      )}

      {error && !data && (
        <p className="px-4 py-10 text-center text-sm text-red-400">
          {error instanceof Error ? error.message : t("common.unknown")}
        </p>
      )}

      {data && (
        <div className="-mt-6 px-4 pb-16">
          <h1 className="mb-3 font-display text-2xl font-bold leading-tight text-white">{data.title}</h1>

          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-white/70">
            {data.year && <span>{data.year}</span>}
            {data.rating > 0 && <span>{data.rating.toFixed(1)}</span>}
            {data.genres.length > 0 && <span className="truncate">{data.genres.slice(0, 3).join(" · ")}</span>}
          </div>

          {/* La première action, pleine largeur et en blanc : la même place et le même poids que
              « Lire » sur une fiche de bibliothèque. Seul le mot change. */}
          {data.libraryId !== null ? (
            <button
              type="button"
              onClick={() => openLibraryTitle(mediaType, data.libraryId!, { discover: null })}
              className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-3 text-base font-semibold text-ink transition-transform active:scale-95"
            >
              <Play size={18} fill="currentColor" />
              {t("player.discover.open")}
            </button>
          ) : data.requestState ? (
            <div className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-white/10 px-4 py-3 text-sm font-medium text-white/80">
              <StateIcon size={16} />
              {t(`player.requests.state.${data.requestState}`)}
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void request()}
              className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-3 text-base font-semibold text-ink transition-transform active:scale-95 disabled:opacity-60"
            >
              <Plus size={18} />
              {t("player.discover.request")}
            </button>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void setStatus(inList ? null : "to_watch")}
            className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-white/10 px-4 py-3 text-sm font-medium text-white transition-transform active:scale-95 disabled:opacity-60"
          >
            {inList ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
            {inList ? t("player.discover.inList") : t("player.discover.addToList")}
          </button>

          {/* Les favoris vivent chez Jellyfin : ils n'existent que pour un titre qu'on possède.
              Le bouton reste, et dit pourquoi juste en dessous — au survol il n'y a personne, sur
              un téléphone. */}
          <button
            type="button"
            disabled
            className="mb-1 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-md bg-white/5 px-4 py-3 text-sm font-medium text-white/35"
          >
            <Heart size={16} />
            {t("player.discover.favorite")}
          </button>
          <p className="mb-5 text-center text-[11px] leading-4 text-white/35">
            {t("player.discover.favoriteDisabledHint")}
          </p>

          {data.overview && <p className="mb-4 text-sm leading-6 text-white/90">{data.overview}</p>}

          <CastRow cast={data.cast} label={t("player.discover.castTitle")} />
        </div>
      )}
    </div>
  );

  return createPortal(
    isMobile ? (
      mobileSheet
    ) : (
    <div
      ref={containerRef}
      className={`fixed inset-0 overflow-hidden bg-ink ${
        leaving ? "animate-fade-out" : revealed ? "" : "animate-fade-in"
      }`}
      // Le rail passe par-dessus tout : la fiche lui réserve sa bande, comme celles de la
      // bibliothèque. La variable vaut 0 hors du lecteur.
      style={{
        zIndex: 47,
        paddingLeft: "calc(var(--player-rail, 0px) + env(safe-area-inset-left, 0px))",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      {data?.backdrop && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={data.backdrop} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
      <div
        className="absolute inset-x-0 bottom-0 backdrop-blur-md"
        style={{
          height: "45%",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
        }}
      />
      <div className="absolute inset-0" style={{ background: VERTICAL_VEIL }} />
      <div className="absolute inset-0" style={{ background: HORIZONTAL_VEIL }} />

      <button
        onClick={close}
        // `absolute`, pas `fixed` : la racine porte déjà le retrait du rail, et sur téléphone
        // elle s'anime en translation — un enfant `fixed` se positionnerait alors par rapport à
        // elle plutôt qu'à la fenêtre, ce qui rend le placement dépendant de l'animation. En
        // absolu, il se cale sur la boîte de contenu, rail déjà déduit.
        className="btn btn-ghost absolute left-4 z-10 rounded-full bg-black/55 px-3 py-2"
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
      >
        <ArrowLeft size={16} /> {t("cinema.back")}
      </button>

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      )}

      {error && !data && (
        <div className="absolute inset-0 flex items-center justify-center px-8 text-center">
          <p className="text-sm text-red-400">{error instanceof Error ? error.message : t("common.unknown")}</p>
        </div>
      )}

      {data && (
        <div className="scrollbar-thin relative h-full overflow-y-auto">
          <div className={SECTION_CLASS}>
            <div style={COLUMN_STYLE} className={`flex animate-fade-in-up flex-col ${COLUMN_GAP} px-8 sm:px-16`}>
              <h1 className="font-display text-2xl font-bold leading-tight text-white drop-shadow-lg sm:text-4xl">
                {data.title}
              </h1>

              <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
                {data.year && <span>{data.year}</span>}
                {data.rating > 0 && <span>{data.rating.toFixed(1)}</span>}
                {data.genres.length > 0 && <span>{data.genres.slice(0, 3).join(" · ")}</span>}
              </div>

              {data.overview && (
                <CinemaOverview
                  text={data.overview}
                  readMore={t("cinema.readMore")}
                  onOpen={() => setShowSynopsis(true)}
                />
              )}

              {data.cast.length > 0 && (
                <p className={CAST_CLASS}>
                  {t("cinema.cast")} {data.cast.slice(0, 5).map((c) => c.name).join(", ")}
                </p>
              )}

              <div data-detail-actions className="mt-2 flex flex-col gap-1" style={MENU_STYLE}>
                {/* La première ligne, celle qui a le focus : « Lire » quand on l'a, « Demander »
                    quand on ne l'a pas, l'état de l'attente quand c'est déjà parti. Toujours au
                    même endroit, toujours avec le même poids. */}
                {data.libraryId !== null ? (
                  <button
                    data-detail-menu
                    onClick={() => openLibraryTitle(mediaType, data.libraryId!, { discover: null })}
                    className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
                  >
                    <span className={MENU_BADGE}>
                      <Play size={14} />
                    </span>
                    <span className="text-sm font-medium">{t("player.discover.open")}</span>
                  </button>
                ) : data.requestState ? (
                  <div className={`${MENU_ROW} text-white/70`}>
                    <span className={MENU_BADGE}>
                      <StateIcon size={14} />
                    </span>
                    <span className="text-sm font-medium">{t(`player.requests.state.${data.requestState}`)}</span>
                  </div>
                ) : (
                  <button
                    data-detail-menu
                    disabled={busy}
                    onClick={() => void request()}
                    className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
                  >
                    <span className={MENU_BADGE}>
                      <Plus size={14} />
                    </span>
                    <span className="text-sm font-medium">{t("player.discover.request")}</span>
                  </button>
                )}

                <button
                  data-detail-menu
                  disabled={busy}
                  onClick={() => void setStatus(inList ? null : "to_watch")}
                  className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}
                >
                  <span className={inList ? MENU_BADGE_ACTIVE : MENU_BADGE}>
                    {inList ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
                  </span>
                  <span className="text-sm font-medium">
                    {inList ? t("player.discover.inList") : t("player.discover.addToList")}
                  </span>
                </button>

                {/* Les favoris vivent chez Jellyfin, donc ils n'existent que pour un titre qu'on
                    possède. Le bouton reste visible et l'explique au survol, plutôt que de
                    disparaître sans rien dire — c'est une règle, pas un oubli. */}
                <button
                  data-detail-menu
                  disabled
                  title={t("player.discover.favoriteDisabledHint")}
                  aria-describedby="player-favorite-hint"
                  className={`${MENU_ROW} cursor-not-allowed text-white/35`}
                >
                  <span className={MENU_BADGE}>
                    <Heart size={14} />
                  </span>
                  <span className="text-sm font-medium">{t("player.discover.favorite")}</span>
                </button>
                <p id="player-favorite-hint" className="sr-only">
                  {t("player.discover.favoriteDisabledHint")}
                </p>
              </div>

              <CastRow cast={data.cast} label={t("player.discover.castTitle")} className="mt-4" />
            </div>
          </div>
        </div>
      )}

      {showSynopsis && data && (
        <CinemaSynopsisModal
          title={data.title}
          text={data.overview}
          closeLabel={t("common.close")}
          onClose={() => setShowSynopsis(false)}
        />
      )}
    </div>
    ),
    document.body
  );
}

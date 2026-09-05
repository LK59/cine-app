"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { ArrowLeft, Plus, Bookmark, BookmarkCheck, Heart, Clock, CalendarClock, CircleCheck, CircleAlert, Play, Users } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { cinemaClose, cinemaNavigate, openLibraryTitle } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { usePlayerTitleActions } from "@/lib/usePlayerTitleActions";
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
import type { PlayerTitlePayload } from "@/app/api/player/title/[type]/[tmdbId]/route";
import type { PlayerRequestState } from "@/lib/playerRequestState";

const STATE_ICON: Record<PlayerRequestState, React.ElementType> = {
  unreleased: CalendarClock,
  processing: Clock,
  available: CircleCheck,
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
export function PlayerDiscoverSheet({ tmdbId, mediaType }: { tmdbId: number; mediaType: "movie" | "series" }) {
  const t = useT();
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

  // Le focus part sur la première action, jamais sur le résumé : c'est ce qu'on est venu faire.
  //
  // Une seule fois, à l'arrivée des données. Sans le garde-fou, chaque revalidation SWR — un
  // retour sur l'onglet suffit — reprenait le focus des mains de la personne en train de lire la
  // distribution.
  const focusPlaced = useRef(false);
  useEffect(() => {
    if (!data || focusPlaced.current) return;
    focusPlaced.current = true;
    focusFirstAction(containerRef.current);
  }, [data]);

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

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 animate-slide-up overflow-hidden bg-ink md:animate-fade-in"
      // Le rail passe par-dessus tout : la fiche lui réserve sa bande, comme celles de la
      // bibliothèque. La variable vaut 0 hors du lecteur.
      style={{ zIndex: 47, paddingLeft: "var(--player-rail, 0px)" }}
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

              {data.cast.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 flex items-center gap-1.5 text-xs text-white/50">
                    <Users size={12} /> {t("player.discover.castTitle")}
                  </p>
                  <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-2">
                    {data.cast.slice(0, 12).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => cinemaNavigate({ person: c.id })}
                        className="flex w-16 shrink-0 flex-col items-center gap-1.5 text-center focus-visible:outline-none"
                      >
                        <span className="h-16 w-16 overflow-hidden rounded-full bg-white/10 ring-1 ring-white/10 transition group-hover:ring-white/30">
                          {c.profilePath ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.profilePath} alt="" className="h-full w-full object-cover" />
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
              )}
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
    </div>,
    document.body
  );
}

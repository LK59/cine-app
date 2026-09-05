"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { ArrowLeft, ChevronLeft, ChevronRight, User, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { cinemaClose, cinemaNavigate, openLibraryTitle, arrivedByBack } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { PlayerResultCard } from "./PlayerResultCard";
import type { PersonPhoto } from "@/app/api/tmdb/person/[id]/photos/route";
import { useIsMobile, useIsShortViewport } from "@/lib/useIsMobile";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";

interface PersonCredit {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  mediaType: "movie" | "tv";
  character: string;
  voteAverage: number;
  inLibrary: boolean;
  libraryId: number | null;
}

interface PersonPayload {
  credits: PersonCredit[];
  name: string | null;
  profilePath: string | null;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownFor: string | null;
}

const TMDB_PROFILE = "https://image.tmdb.org/t/p/w300";

/**
 * Les photos de la personne, en une rangée qu'on fait défiler.
 *
 * Elles existaient déjà côté gestion et n'avaient pas suivi ici. Elles arrivent d'une route à
 * part, en chargement différé : la fiche s'affiche sans les attendre, et la rangée apparaît quand
 * elles sont là — plutôt que de retarder la filmographie, qui est ce qu'on vient voir.
 */
function PhotoRow({ photos, onOpen, label }: { photos: PersonPhoto[]; onOpen: (i: number) => void; label: string }) {
  if (photos.length === 0) return null;
  return (
    <div className="mt-8">
      <h2 className="mb-3 font-display text-lg font-semibold text-white">{label}</h2>
      <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-2">
        {photos.map((photo, i) => (
          <button
            key={photo.filePath}
            type="button"
            onClick={() => onOpen(i)}
            className="h-44 shrink-0 overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10 transition hover:ring-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 sm:h-56"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.filePath}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-auto object-cover"
              style={{ aspectRatio: photo.aspectRatio || 2 / 3 }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Une photo en grand.
 *
 * Portée dans document.body et au-dessus de tout le reste : c'est la seule chose à l'écran tant
 * qu'elle est ouverte. Échap et les flèches, comme partout ailleurs dans cette application.
 */
function PhotoViewer({
  photos,
  index,
  onIndex,
  onClose,
}: {
  photos: PersonPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const prev = useCallback(() => onIndex((index - 1 + photos.length) % photos.length), [index, photos.length, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % photos.length), [index, photos.length, onIndex]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!["Escape", "Backspace", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prev, next, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 grid animate-fade-in place-items-center bg-black/95 p-4"
      style={{ zIndex: 60 }}
      onClick={onClose}
    >
      {photos.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); prev(); }}
            className="btn-overlay absolute left-3 top-1/2 -translate-y-1/2"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); next(); }}
            className="btn-overlay absolute right-3 top-1/2 -translate-y-1/2"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
      <button type="button" onClick={onClose} className="btn-overlay absolute right-3 top-3">
        <X size={20} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photos[index].fullPath}
        alt=""
        decoding="async"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-full rounded-xl object-contain"
      />
      <span className="absolute bottom-5 rounded-full bg-white/10 px-3 py-1 text-xs text-white/70">
        {index + 1} / {photos.length}
      </span>
    </div>,
    document.body
  );
}
const TMDB_POSTER = "https://image.tmdb.org/t/p/w342";

/**
 * La fiche d'une personne, dans le lecteur.
 *
 * Elle existait déjà côté gestion, en neuf cents lignes ; celle-ci en garde ce qui sert à
 * quelqu'un qui cherche quoi regarder — le portrait, une biographie qu'on peut déplier, et la
 * filmographie. Ce qui change vraiment est ailleurs : chaque titre y ouvre une fiche du lecteur,
 * qu'on le possède ou non, au lieu de renvoyer vers une page d'outillage. C'est ce qui fait que
 * l'on ne sort jamais de l'interface.
 */
export function PlayerPersonSheet({ tmdbId, leaving = false }: { tmdbId: number; leaving?: boolean }) {
  const t = useT();
  const isMobile = useIsMobile();
  const short = useIsShortViewport();
  const [expanded, setExpanded] = useState(false);
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const { data, isLoading } = useSWR<PersonPayload>(`/api/tmdb/person/${tmdbId}`, fetcher, {
    revalidateOnFocus: false,
  });
  // Une requête à part, qui ne retarde pas la fiche : la rangée apparaît quand elle arrive.
  const { data: photoData } = useSWR<{ photos: PersonPhoto[] }>(`/api/tmdb/person/${tmdbId}/photos`, fetcher, {
    revalidateOnFocus: false,
  });
  const photos = photoData?.photos ?? [];

  const close = () => cinemaClose({ person: null });
  // Le même geste que sur les fiches de films : on tire la fiche vers le bas pour la refermer.
  // La poignée est le bloc du portrait et du nom — il n'y a pas de bannière ici.
  const swipe = useSwipeToDismiss(close);
  // Montée parce qu'on revient dessus plutôt qu'on l'ouvre : pas d'animation d'entrée — voir
  // `arrivedByBack`. Lu une seule fois, au montage.
  const [revealed] = useState(() => arrivedByBack());

  useEffect(() => {
    // Silencieux tant que la visionneuse est ouverte : elle écoute Échap elle aussi, et deux
    // écouteurs posés sur la même cible se déclenchent tous les deux — une seule touche aurait
    // fermé la photo *et* la fiche derrière.
    if (photoIndex !== null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [photoIndex]);

  // Ce qu'on possède d'abord : c'est ce qui se regarde ce soir. Le serveur trie déjà ainsi, on
  // garde son ordre et on se contente de retirer les entrées sans titre.
  const credits = useMemo(() => (data?.credits ?? []).filter((c) => c.title), [data]);
  const owned = credits.filter((c) => c.inLibrary).length;

  // Même garde que les fiches du mode cinéma : ce composant peut être rendu côté serveur, où
  // `document` n'existe pas et où `createPortal` fait échouer la page entière.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      // L'animation d'entrée pilote la même propriété que le geste : la laisser tourner
      // pendant qu'on tire empêcherait la fiche de suivre le doigt, et la laisser revenir après
      // un retour en place rejouerait toute l'entrée.
      className={`fixed inset-0 overflow-hidden bg-ink ${
        swipe.touched
          ? ""
          : leaving
            ? "animate-fade-out-down md:animate-fade-out"
            : revealed
              ? ""
              : "animate-slide-up md:animate-fade-in"
      }`}
      style={{
        zIndex: 47,
        paddingLeft: "calc(var(--player-rail, 0px) + env(safe-area-inset-left, 0px))",
        paddingRight: "env(safe-area-inset-right, 0px)",
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
      {/* `absolute`, pas `fixed` : la racine porte déjà le retrait du rail, et sur téléphone elle
          s'anime en translation — un enfant `fixed` se positionnerait alors par rapport à elle
          plutôt qu'à la fenêtre. En absolu, il se cale sur la boîte de contenu, rail déjà déduit.

          Deux formes pour un même geste, chacune là où on la cherche : sur téléphone, la croix en
          haut à droite, comme sur toutes les autres fiches ; sur grand écran, le bouton Retour à
          gauche, comme sur celles de la bibliothèque. */}
      {isMobile ? (
        <button
          type="button"
          onClick={close}
          aria-label={t("cinema.back")}
          className="absolute right-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white active:scale-95"
          style={{ top: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          <X size={18} />
        </button>
      ) : (
        <button
          onClick={close}
          className="btn btn-ghost absolute left-4 z-10 rounded-full bg-black/55 px-3 py-2"
          style={{ top: "max(1rem, env(safe-area-inset-top))" }}
        >
          <ArrowLeft size={16} /> {t("cinema.back")}
        </button>
      )}

      <div
        className="scrollbar-thin h-full overflow-y-auto px-5 pb-16 sm:px-10"
        // Sur téléphone, la croix flotte au-dessus du contenu et n'a pas besoin qu'on lui
        // réserve toute une bande : le portrait commence plus haut, ce qui compte sur les
        // ~390 px d'un écran couché.
        style={{ paddingTop: `calc(${isMobile ? "1rem" : "4.5rem"} + env(safe-area-inset-top))` }}
      >
        <div className="mx-auto w-full max-w-6xl">
          {isLoading && (
            <div className="flex justify-center pt-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          )}

          {data && (
            <>
              {/* `pr-12` sur téléphone : la croix flotte dans ce coin, et le nom passait dessous
                  dès qu'il tenait sur la même ligne que le portrait — c'est-à-dire couché. */}
              {/* La poignée du geste : `touch-action: none` pour que le navigateur ne réclame
                  pas ce mouvement pour son propre défilement, sinon il vole le flux de pointeurs
                  au milieu du glissement. Le reste de la fiche défile normalement. */}
              <div
                {...(isMobile ? swipe.handlers : {})}
                style={isMobile ? { touchAction: "none" } : undefined}
                className={`flex gap-6 ${short ? "flex-row items-start" : "flex-col sm:flex-row sm:items-start"} ${isMobile ? "pr-12" : ""}`}
              >
                <div
                  className={`shrink-0 overflow-hidden rounded-2xl bg-white/5 ring-1 ring-white/10 ${
                    short ? "h-28 w-28" : "h-36 w-36 sm:h-44 sm:w-44"
                  }`}
                >
                  {data.profilePath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${TMDB_PROFILE}${data.profilePath}`} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-slate-600">
                      <User size={32} />
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <h1 className={`font-display font-semibold text-white ${short ? "text-2xl" : "text-3xl sm:text-4xl"}`}>
                    {data.name}
                  </h1>
                  <p className="mt-1.5 text-sm text-slate-400">
                    {[
                      data.knownFor,
                      data.birthday ? new Date(data.birthday).getFullYear() : null,
                      data.placeOfBirth,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>

                  {data.biography && (
                    <>
                      <p
                        className={`mt-4 max-w-3xl select-text text-sm leading-7 text-slate-300 ${
                          expanded ? "" : short ? "line-clamp-2" : "line-clamp-4"
                        }`}
                      >
                        {data.biography}
                      </p>
                      <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="mt-1.5 text-xs font-medium text-slate-400 hover:text-white"
                      >
                        {expanded ? t("player.person.less") : t("cinema.readMore")}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <PhotoRow photos={photos} onOpen={setPhotoIndex} label={t("player.person.photos")} />

              <div className={short ? "mt-6" : "mt-10"}>
                <h2 className="font-display text-lg font-semibold text-white">
                  {t("player.person.filmography")}
                  <span className="ml-2 text-sm font-normal text-slate-500">
                    {t("player.person.ownedCount", { owned, total: credits.length })}
                  </span>
                </h2>

                <div className="player-grid mt-5 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
                  {credits.map((c) => {
                    const type = c.mediaType === "movie" ? "movie" : "series";
                    return (
                      <PlayerResultCard
                        key={`${c.mediaType}-${c.tmdbId}`}
                        kind={type}
                        title={c.title}
                        subtitle={c.year ? String(c.year) : c.character || null}
                        poster={c.posterPath ? `${TMDB_POSTER}${c.posterPath}` : null}
                        missing={!c.inLibrary}
                        // Par-dessus la fiche personne, pas à sa place : le retour ramène à la
                        // filmographie. Et l'onglet suit le type, sans quoi une série ouverte
                        // depuis un acteur ne se résolvait pas.
                        onOpen={() =>
                          c.libraryId !== null
                            ? openLibraryTitle(type, c.libraryId)
                            : cinemaNavigate({ discover: c.tmdbId, discoverType: type })
                        }
                      />
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {photoIndex !== null && photos.length > 0 && (
        <PhotoViewer
          photos={photos}
          index={photoIndex}
          onIndex={setPhotoIndex}
          onClose={() => setPhotoIndex(null)}
        />
      )}
    </div>,
    document.body
  );
}

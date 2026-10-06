"use client";

import { useEffect, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { Play, RotateCcw, X } from "lucide-react";
import { cacheOnlyOptions, fetcher, MOVIES_CATALOGUE_KEY, playerBootstrapOptions, TO_WATCH_KEY } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import { useT } from "@/components/TranslationProvider";
import { PosterImage } from "@/components/PosterImage";
import { similarInLibrary } from "@/lib/cinemaSimilar";
import { uniqueById } from "@/lib/cinemaRails";
import { useCinemaCollection, type ResolvedPart } from "@/components/cinema/CinemaCollectionRow";
import { collectionSuite } from "@/lib/collectionSuite";
import { useJellyfinItemState } from "@/lib/useJellyfinItemState";
import { resumeAtFor } from "@/lib/resumePosition";
import { liquidButtonRef } from "@/lib/liquidGlass/liquid";
import type { CinemaMovie, CinemaMoviesPayload } from "@/app/api/cinema/movies/route";

/**
 * La fin d'un film.
 *
 * Une série enchaîne — le décompte du prochain épisode existe depuis longtemps. Un film, lui,
 * tombait dans le vide : la dernière image se figeait et il ne restait qu'une croix. C'est
 * pourtant le moment où quelqu'un est le plus disponible pour lancer autre chose.
 *
 * L'écran se fond dans le lecteur plutôt que de le remplacer : le film reste dessous, assombri,
 * et ce qu'on propose se pose par-dessus. Fermer ramène à l'interface par le même fondu que
 * partout ailleurs.
 *
 * Les titres proposés sont ceux de la bibliothèque, et rien d'autre : chacun peut être lancé sur
 *-le-champ. Proposer ici ce qu'on n'a pas serait offrir une porte sur une salle d'attente.
 */
export function PlayerEndScreen({
  itemId,
  title,
  onReplay,
  onClose,
  onOpenTitle,
  onPlayNext,
}: {
  itemId: string;
  title: string;
  onReplay: () => void;
  onClose: () => void;
  onOpenTitle: (movie: CinemaMovie) => void;
  /**
   * Lancer « la suite » de la saga. `resumeAt` est toujours un nombre : l'état du film est lu
   * avant de le proposer, donc sa position est connue — zéro pour un film jamais commencé.
   */
  onPlayNext?: (movie: CinemaMovie, resumeAt: number) => void;
}) {
  const t = useT();
  // Lu dans le cache, jamais redemandé : c'est la charge utile que l'écran d'accueil tient déjà
  // à jour, et la revalider ici coûterait un mégaoctet et demi pour une rangée de fin.
  const { data } = useSWR<CinemaMoviesPayload>(MOVIES_CATALOGUE_KEY, cinemaFetcher, cacheOnlyOptions);

  const all = data ? uniqueById([...data.spotlight, ...Object.values(data.rows).flat()], (m) => m.radarrId) : [];
  const subject = all.find((m) => m.jellyfinItemId === itemId) ?? null;
  const similar = subject ? similarInLibrary(subject, all, (m) => m.radarrId === subject.radarrId).slice(0, 8) : [];
  // La saga de ce film, par le même chemin que sa rangée sur la fiche — les mêmes clés, souvent déjà
  // en cache depuis la fiche d'où le film a été lancé.
  const collection = useCinemaCollection(subject?.radarrId ?? null, { whilePlaying: true });

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-linear-to-t from-black via-black/85 to-black/40">
      <FinishedAsk itemId={itemId} />
      <div className="mx-auto w-full max-w-4xl px-6 pb-10 sm:px-10">
        <p className="text-xs uppercase tracking-wide text-subtle">{t("player.end.finished")}</p>
        <h2 className="mt-1 truncate font-display text-2xl font-semibold text-white sm:text-3xl">{title}</h2>

        <div className="mt-5 flex flex-wrap gap-2.5">
          {/* Posés sur la vidéo, comme les commandes du lecteur : leur verre et leur geste (§45). */}
          <button type="button" onClick={onReplay} ref={liquidButtonRef} data-liquid className="btn nav-glass rounded-full text-white">
            <RotateCcw size={16} />
            {t("player.end.replay")}
          </button>
          <button type="button" onClick={onClose} ref={liquidButtonRef} data-liquid className="btn-primary rounded-full">
            <X size={16} />
            {t("player.end.done")}
          </button>
        </div>

        {subject && onPlayNext && (
          <CollectionSuiteCard parts={collection.all} currentRadarrId={subject.radarrId} watched={{}} resumeTicks={{}} onPlay={onPlayNext} />
        )}

        {similar.length > 0 && (
          <section className="mt-8">
            <h3 className="mb-2 text-sm font-medium text-muted">{t("cinema.similar")}</h3>
            <div className="scrollbar-none flex gap-3 overflow-x-auto pb-1">
              {similar.map((movie) => (
                <button
                  key={movie.radarrId}
                  type="button"
                  onClick={() => onOpenTitle(movie)}
                  className="w-24 shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40 transition-transform active:scale-95 sm:w-28"
                >
                  <PosterImage src={movie.posterUrl} alt={movie.title} subtle unoptimized sizes="112px" />
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

interface SuiteProps {
  parts: ResolvedPart[];
  currentRadarrId: number;
  /** Ce qu'on sait déjà de « vu », titre par titre — voir `collectionSuite`. */
  watched: Readonly<Record<string, boolean>>;
  /** La position de reprise de ces mêmes titres, lue dans la même réponse. */
  resumeTicks: Readonly<Record<string, number | null>>;
  onPlay: (movie: CinemaMovie, resumeAt: number) => void;
}

/**
 * « La suite » d'une saga : le film qui vient après, s'il y en a un à voir.
 *
 * La décision est `collectionSuite`, et seulement elle (DECISIONS.md §44). Elle attend l'état « vu »
 * d'un film à la fois : ce composant le demande à Jellyfin (`SuiteAsk`) puis la rappelle avec la
 * réponse — un film déjà vu passe la main au suivant, sans autre règle que la sienne.
 *
 * La même forme que la carte de l'épisode suivant, sans décompte ni lecture automatique : un film
 * n'enchaîne pas, il se propose.
 */
function CollectionSuiteCard(props: SuiteProps) {
  const t = useT();
  const suite = collectionSuite(props.parts, props.currentRadarrId, props.watched);
  if (suite.kind === "none") return null;
  if (suite.kind === "ask") return <SuiteAsk key={suite.movie.jellyfinItemId} movie={suite.movie} {...props} />;
  const { movie } = suite;
  const resumeAt = resumeAtFor({ known: true, resumeTicks: props.resumeTicks[movie.jellyfinItemId] });
  return (
    <div data-collection-suite className="nav-glass glass-pop mt-6 w-72 max-w-full rounded-[22px] p-4">
      <p className="mb-1 text-xs text-subtle">{t("player.end.suite")}</p>
      <p className="mb-3 truncate text-sm font-medium text-white">{movie.title}</p>
      <button
        type="button"
        onClick={() => props.onPlay(movie, resumeAt ?? 0)}
        ref={liquidButtonRef}
        data-liquid
        className="btn-primary w-full justify-center py-1.5 text-xs"
      >
        <Play size={14} />
        {t("player.playNow")}
      </button>
    </div>
  );
}

/** L'état d'un film de la saga, lu chez Jellyfin pendant que le lecteur tient l'écran. */
function SuiteAsk({ movie, ...props }: SuiteProps & { movie: CinemaMovie }) {
  const state = useJellyfinItemState(movie.jellyfinItemId, "movie", playerBootstrapOptions);
  // Tant qu'on ne sait pas — ou si Jellyfin n'a pas pu répondre —, rien : proposer un film peut-être
  // déjà vu serait affirmer ce qu'on ignore.
  if (!state.known) return null;
  return (
    <CollectionSuiteCard
      {...props}
      watched={{ ...props.watched, [movie.jellyfinItemId]: state.watched }}
      resumeTicks={{ ...props.resumeTicks, [movie.jellyfinItemId]: state.progress?.resumeTicks ?? null }}
    />
  );
}

type FinishedAnswer = { finished: boolean; type?: "movie" | "series"; tmdbId?: number; title?: string; inToWatch?: boolean };

/**
 * « Vous avez terminé ce film » (DECISIONS.md §51, demandé le 06/10/2026).
 *
 * Le titre vient de passer dans « Vus » — le film, ou la série dont c'était le dernier épisode à
 * voir. S'il est encore dans « À voir », on propose de l'en retirer, sans le faire d'office : on
 * peut vouloir le revoir. Discret, sous les boutons ; rien du tout s'il n'est pas dans la liste.
 *
 * Avec `playerBootstrapOptions` : le film occupe encore l'écran, et une requête mise en pause par
 * SWR serait abandonnée, pas différée (CLAUDE.md).
 */
function FinishedAsk({ itemId }: { itemId: string }) {
  const t = useT();
  const { data } = useSWR<FinishedAnswer>(`/api/player/watched/finished?itemId=${encodeURIComponent(itemId)}`, fetcher, {
    ...playerBootstrapOptions,
    revalidateOnFocus: false,
    revalidateIfStale: false,
  });
  const [state, setState] = useState<"ask" | "busy" | "removed" | "kept">("ask");

  // « Vus » vient de changer : la liste le montre dès qu'on rouvre « Ma liste ».
  useEffect(() => {
    if (data?.finished) void globalMutate("/api/player/lists");
  }, [data?.finished]);

  if (!data?.finished || !data.inToWatch || !data.type || !data.tmdbId || state === "kept") return null;
  const series = data.type === "series";

  async function remove() {
    setState("busy");
    try {
      await apiAction("/api/watchlist", { method: "DELETE", body: JSON.stringify({ tmdbId: data!.tmdbId, mediaType: data!.type }) });
      setState("removed");
      void globalMutate("/api/player/lists");
      void globalMutate(TO_WATCH_KEY);
    } catch {
      setState("ask");
    }
  }

  // Une petite carte dans le coin, hors du chemin des boutons et des titres proposés (07/10/2026) :
  // en bloc sous « Revoir », elle prenait la moitié de l'écran d'un téléphone en paysage.
  return (
    <div
      role="status"
      // Plus bas en portrait (07/10/2026) : sous l'encoche et la barre d'état d'un téléphone tenu
      // droit, la carte était légèrement coupée en haut. En paysage, elle garde le coin.
      className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 w-[min(19rem,calc(100%-2rem))] animate-fade-in rounded-2xl bg-black/55 px-3.5 py-3 text-white ring-1 ring-white/10 backdrop-blur-md portrait:top-[calc(env(safe-area-inset-top,0px)+3rem)]"
    >
      {state === "removed" ? (
        <p className="text-xs text-muted">{t("player.end.finishedRemoved")}</p>
      ) : (
        <>
          <p className="text-xs leading-snug">{t(series ? "player.end.finishedSeriesAsk" : "player.end.finishedMovieAsk")}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-subtle">{t(series ? "player.end.finishedSeriesNote" : "player.end.finishedMovieNote")}</p>
          <div className="mt-2 flex gap-1.5">
            <button type="button" disabled={state === "busy"} onClick={() => void remove()} ref={liquidButtonRef} data-liquid className="rounded-full bg-white px-3 py-1 text-xs font-medium text-ink disabled:opacity-60">
              {t("player.end.finishedRemove")}
            </button>
            <button type="button" onClick={() => setState("kept")} ref={liquidButtonRef} data-liquid className="rounded-full px-3 py-1 text-xs text-muted hover:text-white">
              {t("player.end.finishedKeep")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

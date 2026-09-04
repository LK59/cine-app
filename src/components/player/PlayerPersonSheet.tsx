"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { ArrowLeft, User } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { cinemaClose, cinemaNavigate } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { PlayerResultCard } from "./PlayerResultCard";

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
export function PlayerPersonSheet({ tmdbId }: { tmdbId: number }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useSWR<PersonPayload>(`/api/tmdb/person/${tmdbId}`, fetcher, {
    revalidateOnFocus: false,
  });

  const close = () => cinemaClose({ person: null });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Ce qu'on possède d'abord : c'est ce qui se regarde ce soir. Le serveur trie déjà ainsi, on
  // garde son ordre et on se contente de retirer les entrées sans titre.
  const credits = useMemo(() => (data?.credits ?? []).filter((c) => c.title), [data]);
  const owned = credits.filter((c) => c.inLibrary).length;

  // Même garde que les fiches du mode cinéma : ce composant peut être rendu côté serveur, où
  // `document` n'existe pas et où `createPortal` fait échouer la page entière.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 animate-fade-in overflow-hidden bg-ink"
      style={{ zIndex: 49, paddingLeft: "var(--player-rail, 0px)" }}
    >
      <button
        onClick={close}
        className="btn btn-ghost fixed z-10 rounded-full bg-black/55 px-3 py-2"
        style={{ top: "max(1rem, env(safe-area-inset-top))", left: "calc(1rem + var(--player-rail, 0px))" }}
      >
        <ArrowLeft size={16} /> {t("cinema.back")}
      </button>

      <div
        className="scrollbar-thin h-full overflow-y-auto px-5 pb-16 sm:px-10"
        style={{ paddingTop: "calc(4.5rem + env(safe-area-inset-top))" }}
      >
        <div className="mx-auto w-full max-w-6xl">
          {isLoading && (
            <div className="flex justify-center pt-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            </div>
          )}

          {data && (
            <>
              <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
                <div className="h-36 w-36 shrink-0 overflow-hidden rounded-2xl bg-white/5 ring-1 ring-white/10 sm:h-44 sm:w-44">
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
                  <h1 className="font-display text-3xl font-semibold text-white sm:text-4xl">{data.name}</h1>
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
                      <p className={`mt-4 max-w-3xl select-text text-sm leading-7 text-slate-300 ${expanded ? "" : "line-clamp-4"}`}>
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

              <div className="mt-10">
                <h2 className="font-display text-lg font-semibold text-white">
                  {t("player.person.filmography")}
                  <span className="ml-2 text-sm font-normal text-slate-500">
                    {t("player.person.ownedCount", { owned, total: credits.length })}
                  </span>
                </h2>

                <div className="mt-5 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
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
                        onOpen={() =>
                          c.libraryId !== null
                            ? cinemaNavigate(
                                type === "movie"
                                  ? { person: null, film: c.libraryId }
                                  : { person: null, serie: c.libraryId }
                              )
                            : cinemaNavigate({ person: null, discover: c.tmdbId, discoverType: type })
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
    </div>,
    document.body
  );
}

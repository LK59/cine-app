"use client";

import useSWR from "swr";
import { RotateCcw, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { PosterImage } from "@/components/PosterImage";
import { similarInLibrary } from "@/lib/cinemaSimilar";
import { uniqueById } from "@/lib/cinemaRails";
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
}: {
  itemId: string;
  title: string;
  onReplay: () => void;
  onClose: () => void;
  onOpenTitle: (movie: CinemaMovie) => void;
}) {
  const t = useT();
  // Lu dans le cache, jamais redemandé : c'est la charge utile que l'écran d'accueil tient déjà
  // à jour, et la revalider ici coûterait un mégaoctet et demi pour une rangée de fin.
  const { data } = useSWR<CinemaMoviesPayload>("/api/cinema/movies", fetcher, {
    revalidateOnMount: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
  });

  const all = data ? uniqueById([...data.spotlight, ...Object.values(data.rows).flat()], (m) => m.radarrId) : [];
  const subject = all.find((m) => m.jellyfinItemId === itemId) ?? null;
  const similar = subject ? similarInLibrary(subject, all, (m) => m.radarrId === subject.radarrId).slice(0, 8) : [];

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-linear-to-t from-black via-black/85 to-black/40">
      <div className="mx-auto w-full max-w-4xl px-6 pb-10 sm:px-10">
        <p className="text-xs uppercase tracking-wide text-white/40">{t("player.end.finished")}</p>
        <h2 className="mt-1 truncate font-display text-2xl font-semibold text-white sm:text-3xl">{title}</h2>

        <div className="mt-5 flex flex-wrap gap-2.5">
          <button type="button" onClick={onReplay} className="btn btn-ghost">
            <RotateCcw size={16} />
            {t("player.end.replay")}
          </button>
          <button type="button" onClick={onClose} className="btn-primary">
            <X size={16} />
            {t("player.end.done")}
          </button>
        </div>

        {similar.length > 0 && (
          <section className="mt-8">
            <h3 className="mb-2 text-sm font-medium text-white/70">{t("cinema.similar")}</h3>
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

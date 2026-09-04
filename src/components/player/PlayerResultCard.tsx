"use client";

import { Film, Tv, User } from "lucide-react";
import { PosterImage } from "@/components/PosterImage";
import { useT } from "@/components/TranslationProvider";

export type ResultKind = "movie" | "series" | "person";

/**
 * La carte de résultat, partagée par la recherche, Ma liste et les filmographies.
 *
 * Une seule carte pour les trois : c'est ce qui fait qu'une grille mélangée reste lisible — même
 * cadre, même titre à la même hauteur, même pastille au même endroit. La seule différence est le
 * mot de la pastille, et c'est justement l'information qu'on cherche quand un film et une série
 * portent le même nom.
 *
 * Aucun nom d'outil n'apparaît : « Film » et « Série », jamais la provenance.
 */
export function PlayerResultCard({
  kind,
  title,
  subtitle,
  poster,
  missing,
  onOpen,
}: {
  kind: ResultKind;
  title: string;
  subtitle?: string | null;
  poster: string | null;
  /** Absent de la bibliothèque — la carte le dit, discrètement, plutôt que de mentir. */
  missing?: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const Icon = kind === "movie" ? Film : kind === "series" ? Tv : User;
  const kindLabel = t(kind === "movie" ? "player.kind.movie" : kind === "series" ? "player.kind.series" : "player.kind.person");

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col text-left focus-visible:outline-none"
    >
      <div className="relative overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10 transition duration-200 group-hover:ring-white/30 group-focus-visible:ring-2 group-focus-visible:ring-accent-500">
        <div className={kind === "person" ? "aspect-[2/3]" : "aspect-[2/3]"}>
          {poster ? (
            <PosterImage src={poster} alt={title} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-slate-600">
              <Icon size={26} />
            </div>
          )}
        </div>

        {/* La pastille de type, en haut à gauche : c'est elle qui départage un film et une série
            du même nom, donc elle est lisible avant le titre. */}
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          <Icon size={10} />
          {kindLabel}
        </span>

        {missing && (
          <span className="absolute bottom-1.5 left-1.5 right-1.5 truncate rounded-md bg-accent-600/90 px-1.5 py-0.5 text-center text-[10px] font-medium text-white">
            {t("player.notInLibrary")}
          </span>
        )}
      </div>

      <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug text-slate-100 transition-colors group-hover:text-white">
        {title}
      </p>
      {subtitle && <p className="mt-0.5 truncate text-[11px] text-slate-500">{subtitle}</p>}
    </button>
  );
}

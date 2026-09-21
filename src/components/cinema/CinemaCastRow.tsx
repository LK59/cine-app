"use client";

import { memo } from "react";
import { User } from "lucide-react";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";

/** Un membre de la distribution, tel que les routes `…/info` le donnent (TMDB, douze au plus). */
export interface CinemaCastMember {
  tmdbId: number;
  name: string;
  character: string;
  photoUrl: string | null;
}

/**
 * La distribution d'un titre, en visages — une seule rangée pour les trois fiches.
 *
 * Revenue le 21/09/2026 : en copiant Netflix, les fiches n'avaient gardé qu'une ligne de noms
 * (« Avec … ») et la partie qu'on aimait dans la gestion avait disparu — des têtes sur lesquelles
 * on tape pour ouvrir la fiche de la personne. Chaque visage y mène, sans quitter le cinéma : la
 * fiche personne se pose par-dessus le titre, et se referme d'un geste vers le bas.
 *
 * Même forme que les rangées voisines (saga, titres similaires) et même attribut : les flèches y
 * entrent et en sortent comme dans les autres — voir `similarRowKeyNav`, qui parcourt tout ce qui
 * porte `data-detail-similar`. Une rangée à part, c'était un troisième chemin au clavier.
 *
 * Mémoïsée pour la même raison que `CinemaSimilarRow` : elle est en bas d'une fiche que le
 * moindre changement d'adresse redessine.
 */
export const CinemaCastRow = memo(function CinemaCastRow({ cast }: { cast: CinemaCastMember[] }) {
  const t = useT();
  if (cast.length === 0) return null;

  return (
    <section className="w-full">
      <h2 className="mb-2 text-sm font-medium text-white/70">{t("cinema.castTitle")}</h2>
      {/* py-4 + overflow-y-hidden, comme la rangée des titres similaires : un visage qui grandit
          au focus a besoin de place dans la boîte, et la molette revient à la page. */}
      <div className="scrollbar-thin flex gap-4 overflow-x-auto overflow-y-hidden py-4">
        {cast.map((member) => (
          <button
            key={member.tmdbId}
            type="button"
            data-detail-similar
            onClick={() => cinemaNavigate({ person: member.tmdbId })}
            className="group flex w-20 shrink-0 flex-col items-center gap-2 text-center outline-none sm:w-24"
          >
            <span className="block aspect-square w-full overflow-hidden rounded-full bg-white/5 shadow-lg shadow-black/40 ring-1 ring-white/10 transition-transform group-hover:scale-105 group-focus-visible:scale-105 group-focus-visible:ring-2 group-focus-visible:ring-white/70">
              {member.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={member.photoUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-slate-600">
                  <User size={24} />
                </span>
              )}
            </span>
            <span className="w-full">
              <span className="line-clamp-2 text-xs font-medium leading-tight text-white">{member.name}</span>
              {member.character && (
                <span className="mt-0.5 line-clamp-1 text-[11px] leading-tight text-white/50">{member.character}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
});

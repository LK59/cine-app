"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/TranslationProvider";
import { PlayerResultCard } from "./PlayerResultCard";

export interface DescribedEntry {
  key: string;
  kind: "movie" | "series";
  title: string;
  year: number | null;
  poster: string | null;
  libraryId: number | null;
  tmdbId: number | null;
}

/**
 * Les titres trouvés d'après une description (`describeSearch.ts`), en une rangée au-dessus de la
 * grille de recherche.
 *
 * Une rangée à part, et sur **une seule ligne** qui défile de côté : elle arrive une seconde après
 * la grille, et une grille où des cartes s'insèrent en tête ferait sauter ce qu'on s'apprêtait à
 * toucher. La rangée prend sa place dès que la frappe est une description — squelettes de la taille
 * des cartes, colonnes de la grille —, si bien que ses résultats remplacent les squelettes sans
 * rien pousser. Elle ne disparaît que si la description n'a rien donné de neuf.
 *
 * Rien d'autre que des cartes : ni phrase du modèle, ni explication. Après trois secondes, une
 * ligne dit qu'il faut encore un instant (`SlowHint`).
 */
export function DescribedResults({
  entries,
  loading,
  waitKey,
  onOpen,
}: {
  entries: DescribedEntry[];
  loading: boolean;
  /** Ce qui est cherché : l'attente recommence à zéro quand il change. */
  waitKey: string;
  onOpen: (entry: DescribedEntry) => void;
}) {
  const t = useT();
  if (!loading && entries.length === 0) return null;
  const width = "w-[calc((100%-1.5rem)/3)] shrink-0 sm:w-[calc((100%-2.25rem)/4)] md:w-[calc((100%-3rem)/5)] lg:w-[calc((100%-3.75rem)/6)]";
  return (
    <section className="mt-6" aria-busy={loading}>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-sm font-semibold text-white">{t("player.search.describe.title")}</h2>
        {loading && <SlowHint key={waitKey} />}
      </div>
      <div className="scrollbar-none -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
        {loading
          ? [0, 1, 2].map((i) => (
              <div key={i} aria-hidden className={width}>
                <div className="skeleton aspect-[2/3] rounded-lg" />
                <div className="mt-2 min-h-[2.75em] text-[13px] leading-snug">
                  <div className="skeleton h-3 w-4/5 rounded" />
                </div>
                <div className="skeleton mt-0.5 h-2.5 w-1/3 rounded" />
              </div>
            ))
          : entries.map((entry) => (
              <div key={entry.key} className={`${width} animate-fade-in`}>
                <PlayerResultCard
                  kind={entry.kind}
                  title={entry.title}
                  subtitle={entry.year ? String(entry.year) : null}
                  poster={entry.poster}
                  missing={entry.libraryId === null}
                  uniform
                  onOpen={() => onOpen(entry)}
                />
              </div>
            ))}
      </div>
    </section>
  );
}

/** « Encore un instant… », passé trois secondes d'attente — et rien avant. */
function SlowHint() {
  const t = useT();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, []);
  return slow ? <span className="text-xs text-subtle animate-fade-in">{t("player.search.describe.slow")}</span> : null;
}

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
 * Les titres trouvés d'après une description (`describeSearch.ts`), au-dessus de la grille de
 * recherche, dans **la même grille** qu'elle — mêmes colonnes, même carte.
 *
 * Une rangée qui défilait de côté a été essayée le 07/11/2026 et retirée le jour même : sur iPhone,
 * des affiches de tailles différentes, et sept séries trouvées dont trois seulement à l'écran sous
 * une puce « Tout 7 ». Tout ce qui est compté se voit. Pendant l'attente, une ligne de squelettes de
 * la taille des cartes tient la place.
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
  return (
    <section className="mt-6" aria-busy={loading}>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-sm font-semibold text-white">{t("player.search.describe.title")}</h2>
        {loading && <SlowHint key={waitKey} />}
      </div>
      <div className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 player-grid-fluid">
        {loading
          ? [0, 1, 2].map((i) => (
              <div key={i} aria-hidden>
                <div className="skeleton aspect-[2/3] rounded-lg" />
                <div className="mt-2 min-h-[2.75em] text-[13px] leading-snug">
                  <div className="skeleton h-3 w-4/5 rounded" />
                </div>
                <div className="skeleton mt-0.5 h-2.5 w-1/3 rounded" />
              </div>
            ))
          : entries.map((entry) => (
              // La carte est la case de la grille, comme dans la grille ordinaire : un `<button>`
              // enveloppé dans une case prend la largeur de son contenu, pas celle de la colonne —
              // chaque affiche avait sa propre taille sur iPhone (07/11/2026).
              <PlayerResultCard
                  key={entry.key}
                  kind={entry.kind}
                  title={entry.title}
                  subtitle={entry.year ? String(entry.year) : null}
                  poster={entry.poster}
                  missing={entry.libraryId === null}
                  uniform
                  onOpen={() => onOpen(entry)}
                />
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

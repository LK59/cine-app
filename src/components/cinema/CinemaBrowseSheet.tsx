"use client";

import { useMemo, useState } from "react";
import { useT } from "@/components/TranslationProvider";
import { PlayerPanelFrame } from "@/components/player/PlayerPanelFrame";
import { PlayerResultCard } from "@/components/player/PlayerResultCard";
import { openLibraryTitle } from "@/lib/cinemaRoute";
import {
  browseTitles,
  decadesOf,
  BROWSE_ALL,
  BROWSE_SORTS,
  type BrowseSort,
  type BrowsableTitle,
} from "@/lib/cinemaBrowse";

/**
 * La grille complète.
 *
 * L'accueil est fait de rangées, et une rangée s'arrête à vingt-quatre affiches : sur six cent
 * soixante-dix films, la bibliothèque paraissait bien plus petite qu'elle n'est, et on ne pouvait
 * l'atteindre en entier qu'en sachant d'avance ce qu'on cherchait. C'est l'écran qui manquait pour
 * flâner — la seule chose qu'on fait vraiment devant une bibliothèque.
 *
 * Un seul composant pour le bureau et le téléphone : il emprunte le cadre des panneaux du lecteur,
 * qui porte déjà le retrait du rail, le menu du téléphone, Échap et le focus.
 */
export function CinemaBrowseSheet<T extends BrowsableTitle>({
  genre,
  mediaType,
  items,
  genres,
  idOf,
  posterOf,
  libraryIdOf,
  leaving,
}: {
  /** Un genre, ou `BROWSE_ALL` pour toute la bibliothèque. */
  genre: string;
  mediaType: "movies" | "series";
  items: T[];
  genres: string[];
  idOf: (item: T) => number;
  posterOf: (item: T) => string | null;
  libraryIdOf: (item: T) => number;
  leaving?: boolean;
}) {
  const t = useT();
  // Le genre vient de l'adresse et ne bouge pas ; le reste se règle ici, et volontairement pas
  // dans l'adresse — trier ne change pas d'écran, et remplir l'historique de tris ferait du
  // bouton retour une machine à défaire des réglages.
  const [sort, setSort] = useState<BrowseSort>("added");
  const [decade, setDecade] = useState<number | null>(null);
  const [query, setQuery] = useState("");

  const decades = useMemo(() => decadesOf(items), [items]);
  const shown = useMemo(
    () => browseTitles(items, { genre, decade, sort, query }),
    [items, genre, decade, sort, query]
  );

  const title = genre === BROWSE_ALL ? t(`player.browse.all.${mediaType}`) : genre;

  return (
    <PlayerPanelFrame
      leaving={leaving}
      title={title}
      subtitle={t("player.browse.count", { n: shown.length })}
    >
      <div className="mx-auto w-full max-w-6xl">
        {/* Les réglages tiennent sur une ligne qui défile plutôt que sur trois rangs empilés :
            debout, l'en-tête mangeait sinon la moitié de l'écran avant la première affiche. */}
        <div className="relative -mx-1 mb-5">
          <div className="scrollbar-none flex gap-2 overflow-x-auto px-1 pb-1">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("player.browse.filter")}
              className="input h-9 w-40 shrink-0 text-sm"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as BrowseSort)}
              aria-label={t("player.browse.sort")}
              className="select h-9 shrink-0 text-sm"
            >
              {BROWSE_SORTS.map((key) => (
                <option key={key} value={key}>
                  {t(`player.browse.sorts.${key}`)}
                </option>
              ))}
            </select>
            {/* Les décennies proposées sont celles que la bibliothèque contient — voir decadesOf. */}
            {decades.length > 1 && (
              <select
                value={decade ?? ""}
                onChange={(e) => setDecade(e.target.value ? Number(e.target.value) : null)}
                aria-label={t("player.browse.decade")}
                className="select h-9 shrink-0 text-sm"
              >
                <option value="">{t("player.browse.allDecades")}</option>
                {decades.map((d) => (
                  <option key={d} value={d}>
                    {d}s
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink to-transparent" />
        </div>

        {shown.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-500">{t("player.browse.nothing")}</p>
        ) : (
          // `player-grid` : c'est lui qui porte `content-visibility`, et sans lui le navigateur
          // met en page et dessine les six cent soixante-dix cartes d'un coup — la grille
          // complète est justement le seul écran où ce nombre est atteint.
          <div className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {shown.map((item) => (
              <PlayerResultCard
                key={idOf(item)}
                kind={mediaType === "series" ? "series" : "movie"}
                title={item.title}
                subtitle={item.year ? String(item.year) : null}
                poster={posterOf(item)}
                onOpen={() => openLibraryTitle(mediaType === "series" ? "series" : "movie", libraryIdOf(item))}
              />
            ))}
          </div>
        )}
      </div>
    </PlayerPanelFrame>
  );
}

"use client";

import { useMemo, useRef, useState } from "react";
import { useT } from "@/components/TranslationProvider";
import { PlayerPanelFrame } from "@/components/player/PlayerPanelFrame";
import { PlayerResultCard } from "@/components/player/PlayerResultCard";
import { openLibraryTitle } from "@/lib/cinemaRoute";
import { useDecodeAhead } from "@/lib/useDecodeAhead";
import { genreLabel } from "@/lib/top10Label";
import {
  browseTitles,
  decadesOf,
  BROWSE_ALL,
  BROWSE_SORTS,
  BROWSE_DURATIONS,
  type BrowseDuration,
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
  const [duration, setDuration] = useState<BrowseDuration>("all");
  // La durée n'est connue que des films — voir `BrowseDuration`.
  const hasDurations = mediaType === "movies" && items.some((item) => (item.runtimeMinutes ?? 0) > 0);
  const [query, setQuery] = useState("");

  const decades = useMemo(() => decadesOf(items), [items]);
  const shown = useMemo(
    () => browseTitles(items, { genre, decade, sort, query, duration }),
    [items, genre, decade, sort, query, duration]
  );

  // Les affiches des deux écrans suivants sont décodées d'avance : c'est leur arrivée pendant le
  // défilement qui saccadait, et non la grille elle-même. Voir `useDecodeAhead`.
  const gridRef = useRef<HTMLDivElement>(null);
  useDecodeAhead(gridRef, shown);

  // Le genre traduit, comme la rangée d'où l'on vient : « Comédie » sur l'accueil puis « Comedy »
  // ici, c'étaient deux noms pour la même chose à un appui d'intervalle.
  const title = genre === BROWSE_ALL ? t(`player.browse.all.${mediaType}`) : genreLabel(genre, t);

  return (
    <PlayerPanelFrame
      leaving={leaving}
      // Poussée depuis « Voir tout », et non choisie dans le rail : elle a un derrière, donc un
      // retour. Voir `back` dans PlayerPanelFrame.
      back
      title={title}
      subtitle={t("player.browse.count", { n: shown.length })}
    >
      <div className="mx-auto w-full max-w-6xl">
        {/* Les réglages tiennent sur une ligne qui défile plutôt que sur trois rangs empilés :
            debout, l'en-tête mangeait sinon la moitié de l'écran avant la première affiche. */}
        <div className="relative -mx-1 mb-5">
          <div className="scrollbar-none flex gap-2 overflow-x-auto px-1 pb-1 fade-end-x">
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
                    {/* La même tournure que le palmarès du jour : l'application disait « années
                        1990 » à un endroit et « 1990s » à l'autre. */}
                    {t("cinema.decade", { decade: d })}
                  </option>
                ))}
              </select>
            )}
            {hasDurations && (
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value as BrowseDuration)}
                aria-label={t("player.browse.duration")}
                className="select h-9 shrink-0 text-sm"
              >
                {BROWSE_DURATIONS.map((key) => (
                  <option key={key} value={key}>
                    {t(`player.browse.durations.${key}`)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="py-16 text-center text-sm text-subtle">{t("player.browse.nothing")}</p>
        ) : (
          // `player-grid` : c'est lui qui porte `content-visibility`, et sans lui le navigateur
          // met en page et dessine les six cent soixante-dix cartes d'un coup — la grille
          // complète est justement le seul écran où ce nombre est atteint.
          <div ref={gridRef} className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {shown.map((item) => (
              <PlayerResultCard
                key={idOf(item)}
                kind={mediaType === "series" ? "series" : "movie"}
                title={item.title}
                subtitle={item.year ? String(item.year) : null}
                poster={posterOf(item)}
                // Cette grille ne montre qu'une sorte à la fois : l'étiquette répéterait « Film »
                // six cent soixante-dix fois, pour un `backdrop-filter` par carte. Voir `showKind`.
                showKind={false}
                onOpen={() => openLibraryTitle(mediaType === "series" ? "series" : "movie", libraryIdOf(item))}
              />
            ))}
          </div>
        )}
      </div>
    </PlayerPanelFrame>
  );
}

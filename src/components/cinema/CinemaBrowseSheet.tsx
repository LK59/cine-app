"use client";

import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { escapeClears } from "@/lib/escapeClears";
import { useT } from "@/components/TranslationProvider";
import { PlayerPanelFrame } from "@/components/player/PlayerPanelFrame";
import { PANEL_WIDE } from "@/components/player/panelWidth";
import { PlayerResultCard } from "@/components/player/PlayerResultCard";
import { openLibraryTitle } from "@/lib/cinemaRoute";
import { useDecodeAhead } from "@/lib/useDecodeAhead";
import { genreLabel } from "@/lib/top10Label";
import {
  filterTitles,
  sortTitles,
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
/** De quoi remplir un premier écran, même grand : 7 colonnes × 4 rangées. */
const FIRST_SCREEN_CARDS = 28;

type BrowseSheetProps<T extends BrowsableTitle> = {
  /** Un genre, ou `BROWSE_ALL` pour toute la bibliothèque. */
  genre: string;
  mediaType: "movies" | "series";
  items: T[];
  genres: string[];
  /**
   * Les trois projections ci-dessous lisent un champ de l'élément et rien d'autre : leur identité
   * ne compte pas, seule la sorte (`mediaType`) en change le sens — voir `sameSheet`.
   */
  idOf: (item: T) => number;
  posterOf: (item: T) => string | null;
  libraryIdOf: (item: T) => number;
  leaving?: boolean;
};

/**
 * La grille ne se redessine que si ce qu'elle montre change (08/10/2026).
 *
 * L'accueil se redessine à chaque changement d'adresse — ouvrir une fiche depuis la grille, la
 * refermer — et passait ses projections écrites en ligne : neuves à chaque fois, elles faisaient
 * redessiner six cent soixante-dix cartes sous la fiche, pendant son animation d'entrée. Ce sont
 * des lectures de champ pures, fixées par la sorte : les comparer par identité ne dirait rien.
 */
function sameSheet<T extends BrowsableTitle>(a: BrowseSheetProps<T>, b: BrowseSheetProps<T>): boolean {
  return a.genre === b.genre && a.mediaType === b.mediaType && a.items === b.items && a.genres === b.genres && a.leaving === b.leaving;
}

export const CinemaBrowseSheet = memo(BrowseSheet, sameSheet) as <T extends BrowsableTitle>(props: BrowseSheetProps<T>) => React.ReactElement | null;

/**
 * Les cartes, à part : la feuille se redessine à chaque frappe dans son filtre, et pendant ce rendu
 * urgent la grille affichée est encore l'ancienne (`useDeferredValue`) — mémoïsée, elle n'est pas
 * reparcourue. Toutes ses propriétés sont stables tant que la liste ne change pas.
 */
const BrowseGrid = memo(function BrowseGrid<T extends BrowsableTitle>({
  items,
  mediaType,
  idOf,
  posterOf,
  libraryIdOf,
  gridRef,
}: Pick<BrowseSheetProps<T>, "items" | "mediaType" | "idOf" | "posterOf" | "libraryIdOf"> & {
  gridRef: React.RefObject<HTMLDivElement | null>;
}) {
  const kind = mediaType === "series" ? "series" : "movie";
  const open = useCallback((id: number) => openLibraryTitle(kind, id), [kind]);
  return (
    // `player-grid` : c'est lui qui porte `content-visibility`, et sans lui le navigateur
    // met en page et dessine les six cent soixante-dix cartes d'un coup — la grille
    // complète est justement le seul écran où ce nombre est atteint.
    // `grid-hover-zoom` : l'affiche grossit au survol, au pointeur fin seulement (globals.css).
    <div ref={gridRef} className="player-grid grid-hover-zoom grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 player-grid-fluid">
      {items.map((item) => (
        <PlayerResultCard
          key={idOf(item)}
          kind={kind}
          title={item.title}
          subtitle={item.year ? String(item.year) : null}
          poster={posterOf(item)}
          // Cette grille ne montre qu'une sorte à la fois : l'étiquette répéterait « Film »
          // six cent soixante-dix fois, pour un `backdrop-filter` par carte. Voir `showKind`.
          showKind={false}
          openId={libraryIdOf(item)}
          onOpenId={open}
        />
      ))}
    </div>
  );
}) as <T extends BrowsableTitle>(
  props: Pick<BrowseSheetProps<T>, "items" | "mediaType" | "idOf" | "posterOf" | "libraryIdOf"> & {
    gridRef: React.RefObject<HTMLDivElement | null>;
  }
) => React.ReactElement;

function BrowseSheet<T extends BrowsableTitle>({
  genre,
  mediaType,
  items,
  genres,
  idOf,
  posterOf,
  libraryIdOf,
  leaving,
}: BrowseSheetProps<T>) {
  const t = useT();
  // Le genre vient de l'adresse et ne bouge pas ; le reste se règle ici, et volontairement pas
  // dans l'adresse — trier ne change pas d'écran, et remplir l'historique de tris ferait du
  // bouton retour une machine à défaire des réglages.
  const [sort, setSort] = useState<BrowseSort>("added");
  // Le genre se change ici aussi (07/10/2026), à côté des époques et des durées. Il part de celui
  // de la rangée d'où l'on vient ; la feuille est re-clée par genre (`browseSheetKey`), donc un
  // autre « Voir tout » repart du sien. Les genres sont déjà regroupés sous un nom (`genres.ts`).
  // Un genre d'adresse que la liste ne connaît pas (une adresse d'avant le regroupement des
  // genres, « Horror » ; une adresse tapée) : le menu affichait « Tous les genres » pendant que la
  // grille filtrait sur ce genre inconnu — vide, sous un filtre qui disait tout montrer.
  const [pickedGenre, setPickedGenre] = useState(genre === BROWSE_ALL || genres.includes(genre) ? genre : BROWSE_ALL);
  const genreOptions = useMemo(
    () => [...genres].sort((a, b) => genreLabel(a, t).localeCompare(genreLabel(b, t))),
    [genres, t]
  );
  const [decade, setDecade] = useState<number | null>(null);
  const [duration, setDuration] = useState<BrowseDuration>("all");
  // La durée n'est connue que des films — voir `BrowseDuration`.
  const hasDurations = mediaType === "movies" && items.some((item) => (item.runtimeMinutes ?? 0) > 0);
  const [query, setQuery] = useState("");

  const decades = useMemo(() => decadesOf(items), [items]);
  // Trié une fois par tri, puis filtré : filtrer garde l'ordre, et une frappe dans le filtre ne
  // retrie plus les six cent soixante-dix titres (08/10/2026).
  const sorted = useMemo(() => sortTitles(items, sort), [items, sort]);
  const shown = useMemo(
    () => filterTitles(sorted, { genre: pickedGenre, decade, query, duration }),
    [sorted, pickedGenre, decade, query, duration]
  );

  /**
   * La grille s'ouvre sur son premier écran, et le reste se construit derrière.
   *
   * Six cent soixante-dix cartes construites d'un coup avant le premier affichage : la grille
   * mettait un temps à s'ouvrir sur téléphone (04/10/2026). Le premier rendu n'en porte que de quoi
   * remplir l'écran ; React construit la liste entière en arrière-plan, interruptible — le
   * défilement et les filtres restent servis. Un filtre changé suit le même chemin : l'ancienne
   * grille reste le temps que la nouvelle soit prête, avec le fil de chargement au-dessus.
   */
  const firstScreen = useMemo(() => shown.slice(0, FIRST_SCREEN_CARDS), [shown]);
  const grid = useDeferredValue(shown, firstScreen);
  const building = grid !== shown;

  // Les affiches des deux écrans suivants sont décodées d'avance : c'est leur arrivée pendant le
  // défilement qui saccadait, et non la grille elle-même. Voir `useDecodeAhead`.
  const gridRef = useRef<HTMLDivElement>(null);
  useDecodeAhead(gridRef, grid);

  // Le genre traduit, comme la rangée d'où l'on vient : « Comédie » sur l'accueil puis « Comedy »
  // ici, c'étaient deux noms pour la même chose à un appui d'intervalle.
  const title = pickedGenre === BROWSE_ALL ? t(`player.browse.all.${mediaType}`) : genreLabel(pickedGenre, t);

  return (
    <PlayerPanelFrame
      leaving={leaving}
      // Poussée depuis « Voir tout », et non choisie dans le rail : elle a un derrière, donc un
      // retour. Voir `back` dans PlayerPanelFrame.
      back
      title={title}
      subtitle={t("player.browse.count", { n: shown.length })}
      contentWidth={PANEL_WIDE}
    >
      <div className="w-full">
        {/* Les réglages tiennent sur une ligne qui défile plutôt que sur trois rangs empilés :
            debout, l'en-tête mangeait sinon la moitié de l'écran avant la première affiche. */}
        <div className="relative -mx-1 mb-5">
          <div className="scrollbar-none flex gap-2 overflow-x-auto px-1 pb-1">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={escapeClears(query, () => setQuery(""))}
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
            {genreOptions.length > 1 && (
              <select
                value={pickedGenre}
                onChange={(e) => setPickedGenre(e.target.value)}
                aria-label={t("player.browse.genre")}
                className="select h-9 shrink-0 text-sm"
              >
                <option value={BROWSE_ALL}>{t("player.browse.allGenres")}</option>
                {genreOptions.map((g) => (
                  <option key={g} value={g}>
                    {genreLabel(g, t)}
                  </option>
                ))}
              </select>
            )}
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
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-(--panel-bg) to-transparent" />
        </div>

        {/* La grille se construit encore (ouverture, filtre changé) : un fil fin au-dessus, après
            un instant seulement — voir `grid`. */}
        <div className="relative h-0.5" aria-hidden>
          {building && (
            <div className="tab-switch-thread absolute inset-0 overflow-hidden rounded-full">
              <div className="player-loading-line h-full w-full bg-accent-500" />
            </div>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="py-16 text-center text-sm text-subtle">{t("player.browse.nothing")}</p>
        ) : (
          <BrowseGrid items={grid} mediaType={mediaType} idOf={idOf} posterOf={posterOf} libraryIdOf={libraryIdOf} gridRef={gridRef} />
        )}
      </div>
    </PlayerPanelFrame>
  );
}

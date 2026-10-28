"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import type { HomeRow } from "@/lib/books/grouping";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";
import { BookCover } from "./BookCover";
import { BookRequestButton } from "./BookRequests";
import { BookSheetHost } from "./BookSheet";
import { cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";
import { useTvGridNav } from "@/lib/useTvGridNav";
import { openReaderPage } from "@/lib/books/readerOpening";
import { lazyNow } from "./lazyNow";
import type { ComponentProps } from "react";
import type { BooksScreen as BooksScreenType } from "./BooksScreen";
import { createPortal } from "react-dom";

/**
 * L'accueil de la catégorie Livres (option, DECISIONS.md §127), à la place des rangées de films ou
 * de séries : « Continuer la lecture », « Récemment ajoutés », puis des rangées de séries (dans l'ordre
 * des tomes), d'auteurs (par année) et de genres — calculées par le serveur (`/api/books/home`, quelques
 * rangées de vingt livres : jamais la bibliothèque entière sur le téléphone), chacune avec son « Tout voir »
 * vers la grille filtrée, ouverte par-dessus (`#tous=serie=…`, `auteur=…`, `genre=…`). Pas de bannière : une couverture n'est pas une image de fond, et le carrousel des
 * films et séries n'est pas touché.
 *
 * Un livre touché ouvre sa fiche ici même, comme un film : `#livre=<id>` dans l'adresse du cinéma, la
 * couverture qui devient la fiche (`BookSheetHost`). « Lire » mène à la page des livres par un vrai
 * chargement — le lecteur affiche ses chapitres dans des cadres `blob:` que seule la politique de
 * sécurité de cette page permet ; `retour=1` : le refermer ramène ici, sur la fiche.
 */
function openBook(id: string): void {
  cinemaNavigate({ book: id, reading: false });
}

const readFromHome = openReaderPage;

/**
 * « Tous les livres » par-dessus l'accueil, sans changer de page (`#tous=…`, 28/10/2026) : la grille n'a
 * besoin d'aucune politique de sécurité à elle — seul le lecteur en a une. Elle chargeait tout le
 * document `/livres` (~0,6 s sur iPhone), et son retour rechargeait tout le cinéma (~0,7 s).
 */
const BooksBrowse = lazyNow<NonNullable<ComponentProps<typeof BooksScreenType>>>(() => import("./BooksScreen").then((m) => m.BooksScreen));

/** « Tout voir » d'une rangée : la grille, filtrée comme la rangée. */
export function openBooksBrowse(filter: string): void {
  // Le code de la grille d'abord : elle paraît au rendu qui suit l'adresse (`lazyNow`).
  void BooksBrowse.preload()
    .catch(() => {})
    .finally(() => cinemaNavigate({ booksAll: filter || "1", book: null, reading: false }));
}

export const BOOKS_HOME_KEY = "/api/books/home";

export interface BooksHomePayload {
  total: number;
  resume: BookSummary[];
  recent: BookSummary[];
  rows: HomeRow[];
  hidden: number;
}

const EMPTY: BookSummary[] = [];
const EMPTY_ROWS: HomeRow[] = [];

export function BooksHome({ variant }: { variant: "desktop" | "mobile" }) {
  const t = useT();
  const { data, error, isLoading, mutate } = useSWR<BooksHomePayload>(BOOKS_HOME_KEY, fetcher, { revalidateOnFocus: true });
  const resume = data?.resume ?? EMPTY;
  const recent = data?.recent ?? EMPTY;
  const rows = data?.rows ?? EMPTY_ROWS;
  const hidden = data?.hidden ?? 0;
  // Ce que la fiche peut montrer d'emblée, avant sa propre réponse : les livres déjà à l'écran.
  const shown = useMemo(() => [...resume, ...recent, ...rows.flatMap((r) => r.books)], [resume, recent, rows]);
  const desktop = variant === "desktop";
  const pad = desktop ? "px-8 lg:px-12" : "px-4";
  // L'accroche des rangées tient compte de la marge : sans elle, la première carte se collait au bord.
  const snapPad = desktop ? "scroll-px-8 lg:scroll-px-12" : "scroll-px-4";
  const card = desktop ? "w-36 lg:w-40" : "w-28";
  const route = useCinemaRoute();
  const sheetOpen = !!route.book;
  // Les flèches du clavier, comme sur les rangées de films (`useTvGridNav`, attributs `data-tv-*`).
  useTvGridNav(desktop && !sheetOpen);

  return (
    <div
      className={desktop ? "absolute inset-y-0 right-0 z-[9] overflow-y-auto bg-ink pb-16" : "flex-1 overflow-y-auto overscroll-contain"}
      style={
        desktop
          ? { left: "var(--player-rail, 0px)", paddingTop: "calc(max(1rem, env(safe-area-inset-top)) + 4.5rem)" }
          : { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 6rem)" }
      }
      data-books-home
      // Sous une fiche, l'accueil des livres ne répond plus (la règle des fiches de films).
      inert={sheetOpen}
    >
      {isLoading && !data && (
        <div className={`${pad} flex gap-3 pt-2`} aria-hidden>
          {Array.from({ length: desktop ? 7 : 3 }, (_, i) => (
            <div key={i} className={`skeleton ${card} aspect-[2/3] shrink-0 rounded-lg`} />
          ))}
        </div>
      )}
      {error && !data && (
        <div className="mx-auto mt-24 max-w-sm px-6 text-center">
          <p className="text-muted">{t("books.error")}</p>
          <button type="button" onClick={() => void mutate()} className="mt-4 rounded-full bg-white px-5 py-2 text-sm font-semibold text-ink">
            {t("books.retry")}
          </button>
        </div>
      )}
      {data && data.total === 0 && <p className="mx-auto mt-24 max-w-sm px-6 text-center text-muted">{t("books.empty")}</p>}

      {resume.length > 0 && (
        <section className="mb-8">
          <h2 className={`${pad} mb-3 font-display text-lg font-semibold`}>{t("books.continue")}</h2>
          <div className={`${pad} ${snapPad} scrollbar-none flex snap-x gap-4 overflow-x-auto pb-2`}>
            {resume.map((book) => {
              const pct = Math.round((book.progress?.fraction ?? 0) * 100);
              return (
                <button
                  key={book.id}
                  type="button"
                  data-sheet-source=""
                  onClick={() => openBook(book.id)}
                  className={`flex ${desktop ? "w-[20rem]" : "w-[17rem]"} shrink-0 snap-start items-center gap-4 rounded-2xl bg-white/5 p-3 text-left transition-transform duration-200 active:scale-[0.97]`}
                >
                  <div className="w-20 shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40">
                    <BookCover book={book} eager />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 font-display text-base font-semibold leading-snug">{displayTitle(book)}</p>
                    {book.seriesName && (
                      <p className="mt-0.5 truncate text-sm text-subtle">
                        {book.index !== null ? t("books.seriesTome", { series: book.seriesName, n: book.index }) : book.seriesName}
                      </p>
                    )}
                    <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/15">
                      <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="mt-1.5 text-xs text-subtle">{t("books.percentRead", { pct })}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {recent.length > 0 && <Row title={t("books.recent")} filter="tri=recent" books={recent} pad={pad} snapPad={snapPad} card={card} desktop={desktop} />}

      {rows.map((group) => (
        <Row
          key={group.key}
          title={group.title}
          count={group.kind === "series" ? t("books.volumes", { n: group.total }) : t("books.count", { n: group.total })}
          filter={`${group.filter.param}=${encodeURIComponent(group.filter.value)}`}
          books={group.books}
          pad={pad}
          snapPad={snapPad}
          card={card}
          desktop={desktop}
        />
      ))}
      {/* Ce qu'on ne trouve pas se demande (option des demandes, §127) — rien quand elle est coupée. */}
      {data && (
        <div className={`${pad} pb-6`}>
          <BookRequestButton label={t("books.requests.notFoundHome")} />
        </div>
      )}
      {hidden > 0 && (
        <div className={`${pad} pb-4`}>
          <button type="button" onClick={() => openBooksBrowse("1")} className="inline-flex h-10 items-center rounded-full bg-white/10 px-5 text-sm font-semibold text-white transition-colors hover:bg-white/15">
            {t("books.moreRows", { n: hidden })}
          </button>
        </div>
      )}
      {/* La fiche d'un livre, portée dans `body` : hors de l'accueil rendu inerte. Une seule à la fois :
          la grille complète ouverte a la sienne. */}
      {!route.booksAll && <BookSheetHost books={shown} onRead={(_book, id, cover) => void readFromHome(id, cover)} />}
      {route.booksAll &&
        typeof document !== "undefined" &&
        createPortal(<BooksBrowse embedded={{ filter: route.booksAll, onRead: (id, cover) => void readFromHome(id, cover) }} />, document.body)}
    </div>
  );
}

/** Une rangée de l'accueil : son titre, son « Tout voir », et au plus vingt couvertures. */
function Row({
  title,
  count,
  filter,
  books,
  pad,
  snapPad,
  card,
  desktop,
}: {
  title: string;
  count?: string;
  /** Les filtres de « Tout voir » (`auteur=…`, `tri=recent`). */
  filter: string;
  books: BookSummary[];
  pad: string;
  snapPad: string;
  card: string;
  desktop: boolean;
}) {
  // La rangée, pour la navigation au clavier (`useTvGridNav`) : son « Tout voir » la nomme d'une façon unique.
  const rowKey = filter;
  const t = useT();
  return (
    <section className="mb-8">
      <div className={`${pad} mb-3 flex items-baseline gap-3`}>
        <h2 className="truncate font-display text-lg font-semibold">{title}</h2>
        {count && <span className="shrink-0 text-sm text-subtle">{count}</span>}
        <button type="button" onClick={() => openBooksBrowse(filter)} className="ml-auto shrink-0 text-sm text-subtle transition-colors hover:text-white">
          {t("books.seeAll")}
        </button>
      </div>
      <div className={`${pad} ${snapPad} scrollbar-none flex snap-x overflow-x-auto pb-2 ${desktop ? "gap-4" : "gap-3"}`}>
        {books.map((book, i) => {
          const pct = book.progress && !book.progress.finished ? Math.round(book.progress.fraction * 100) : 0;
          return (
            <button
              key={book.id}
              type="button"
              data-sheet-source=""
              data-tv-card=""
              data-tv-row={rowKey}
              data-tv-col={i}
              onClick={() => openBook(book.id)}
              className={`group ${card} shrink-0 snap-start text-left focus-visible:outline-none`}
            >
              <div className="relative overflow-hidden rounded-lg shadow-lg shadow-black/40 transition-transform duration-200 group-hover:scale-[1.03] group-active:scale-[0.96]">
                <BookCover book={book} />
                {pct > 0 && (
                  <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                    <div className="h-full bg-white" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{displayTitle(book)}</p>
              {book.index !== null && book.seriesName && <p className="mt-0.5 text-xs text-subtle">{t("books.tome", { n: book.index })}</p>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

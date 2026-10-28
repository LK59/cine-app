"use client";

import { useEffect, useMemo, useRef } from "react";
import { useT } from "@/components/TranslationProvider";
import { groupBooks } from "@/lib/books/grouping";
import { displayTitle } from "@/lib/books/displayTitle";
import { MIN_STARTED_FRACTION, type BookSummary } from "@/lib/books/types";
import { BookCover } from "./BookCover";

/** Les livres demandés au serveur à chaque fois que le bas de la grille approche. */
export const GRID_CHUNK = 120;

/**
 * La grille complète des livres (DECISIONS.md §127), par séries, **par pages** : le serveur n'en envoie
 * que `GRID_CHUNK` à la fois (`/api/books?offset=…`), et un repère invisible sous la dernière carte
 * demande la page suivante quand il approche de l'écran (`IntersectionObserver`, 1 500 px d'avance).
 * Les cartes hors du champ ne sont ni mises en page ni peintes (`content-visibility: auto`, à une hauteur
 * réservée) ; les couvertures se chargent à l'approche (`loading="lazy"`). Remontée à chaque filtre
 * (`key` chez l'appelant) : on repart du haut.
 */
export function BooksGrid({
  books,
  onOpen,
  flat = false,
  more = false,
  onMore,
  seriesCounts,
}: {
  books: readonly BookSummary[];
  onOpen: (book: BookSummary) => void;
  flat?: boolean;
  more?: boolean;
  onMore?: () => void;
  /** Le nombre de tomes de chaque série sur toute la grille filtrée, pas seulement sur les pages reçues. */
  seriesCounts?: Record<string, number>;
}) {
  const t = useT();
  const sentinel = useRef<HTMLDivElement>(null);
  // Triée autrement que par séries (`flat`), la grille est une seule section, dans l'ordre reçu.
  const groups = useMemo(() => (flat ? [{ key: "all", series: null, books: [...books] }] : groupBooks(books)), [books, flat]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || !onMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMore();
      },
      { rootMargin: "1500px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, onMore, books.length]);

  return (
    <>
      {groups.map((group) => {
        const count = group.series ? (seriesCounts?.[group.series] ?? group.books.length) : 0;
        return (
          <section key={group.key} className="mb-10">
            {!flat && (
              <div className="mb-3 flex items-baseline gap-3 px-4 sm:px-8">
                <h2 className="font-display text-lg font-semibold">{group.series ?? t("books.others")}</h2>
                {group.series && <span className="text-sm text-subtle">{count === 1 ? t("books.volumesOne") : t("books.volumes", { n: count })}</span>}
              </div>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-6 px-4 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] sm:gap-x-5 sm:px-8 lg:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]">
              {group.books.map((book) => (
                <BookCard key={book.id} book={book} onOpen={onOpen} />
              ))}
            </div>
          </section>
        );
      })}
      {more && <div ref={sentinel} className="h-px" aria-hidden data-grid-more />}
    </>
  );
}

export function BookCard({ book, onOpen }: { book: BookSummary; onOpen: (book: BookSummary) => void }) {
  const t = useT();
  const pct = book.progress && !book.progress.finished && book.progress.fraction >= MIN_STARTED_FRACTION ? Math.round(book.progress.fraction * 100) : null;
  return (
    <button
      type="button"
      data-book-id={book.id}
      data-sheet-source=""
      onClick={() => onOpen(book)}
      // Hors du champ, la carte n'est ni mise en page ni peinte ; sa hauteur reste réservée (la dernière mesurée).
      className="group text-left [contain-intrinsic-size:auto_18rem] [content-visibility:auto] focus-visible:outline-none"
    >
      <div
        data-book-cover
        className="relative overflow-hidden rounded-lg shadow-lg shadow-black/40 transition-[transform,box-shadow] duration-200 group-hover:scale-[1.03] group-hover:shadow-xl group-hover:shadow-black/60 group-focus-visible:ring-2 group-focus-visible:ring-accent-500 group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-ink group-active:scale-[0.96]"
      >
        <BookCover book={book} />
        {pct !== null && pct > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div className="h-full bg-white" style={{ width: `${pct}%` }} />
          </div>
        )}
        {(book.played || book.progress?.finished) && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white">{t("books.finishedBadge")}</span>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{displayTitle(book)}</p>
      {book.index !== null && book.seriesName ? (
        <p className="mt-0.5 text-xs text-subtle">{t("books.tome", { n: book.index })}</p>
      ) : book.authors[0] ? (
        <p className="mt-0.5 truncate text-xs text-subtle">{book.authors[0]}</p>
      ) : null}
    </button>
  );
}

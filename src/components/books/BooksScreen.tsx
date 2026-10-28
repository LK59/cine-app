"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { ChevronLeft } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { closeBookRoute, openBookRoute, useBookRoute } from "@/lib/books/bookRoute";
import { groupBooks, continueReading } from "@/lib/books/grouping";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";
import { BookCover } from "./BookCover";
import { BookSheet, type MorphOrigin } from "./BookSheet";

/**
 * L'écran des livres (option, DECISIONS.md §127) : « Continuer la lecture » en tête, puis une
 * rangée par série dans l'ordre des tomes, puis les livres sans série. La fiche et le lecteur
 * s'ouvrent par-dessus, chacun avec son entrée d'historique (`bookRoute.ts`).
 *
 * Le lecteur est un morceau à part, chargé à la première ouverture d'un livre : la grille ne
 * télécharge rien de foliate-js.
 */
const BookReader = dynamic(() => import("./BookReader").then((m) => m.BookReader), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-ink">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>
  ),
});

export const BOOKS_KEY = "/api/books";

export function BooksScreen() {
  const t = useT();
  const route = useBookRoute();
  const { data, error, isLoading, mutate } = useSWR<{ books: BookSummary[] }>(BOOKS_KEY, fetcher, { revalidateOnFocus: true });
  const books = useMemo(() => data?.books ?? [], [data]);
  const groups = useMemo(() => groupBooks(books), [books]);
  const resume = useMemo(() => continueReading(books), [books]);
  // Où la couverture touchée était à l'écran : la fiche en part (et y revient).
  const [origin, setOrigin] = useState<MorphOrigin | null>(null);

  const open = (book: BookSummary, el: HTMLElement) => {
    const cover = el.querySelector("[data-book-cover]") ?? el;
    setOrigin({ id: book.id, rect: cover.getBoundingClientRect() });
    openBookRoute({ book: book.id, reading: false });
  };

  const selected = route.book ? (books.find((b) => b.id === route.book) ?? null) : null;

  return (
    <div className="fixed inset-0 overflow-y-auto overscroll-contain bg-ink text-white" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-ink via-ink/90 to-transparent px-4 pb-6 pt-4 sm:px-8">
        {/* Un lien ordinaire : retour au document de l'accueil, et à sa politique de sécurité. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- un vrai chargement, exprès : la page des livres a sa propre politique de sécurité, qu'une navigation de Next garderait. */}
        <a href="/#livres=1" aria-label={t("books.back")} className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white">
          <ChevronLeft size={19} aria-hidden />
        </a>
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("books.title")}</h1>
        {books.length > 0 && <span className="ml-auto text-sm text-subtle">{books.length === 1 ? t("books.countOne") : t("books.count", { n: books.length })}</span>}
      </header>

      <main className="pb-[calc(env(safe-area-inset-bottom)+3rem)]">
        {isLoading && !data && <GridSkeleton />}
        {error && !data && (
          <div className="mx-auto mt-24 max-w-sm px-6 text-center">
            <p className="text-muted">{t("books.error")}</p>
            <button type="button" onClick={() => void mutate()} className="mt-4 rounded-full bg-white px-5 py-2 text-sm font-semibold text-ink">
              {t("books.retry")}
            </button>
          </div>
        )}
        {data && books.length === 0 && <p className="mx-auto mt-24 max-w-sm px-6 text-center text-muted">{t("books.empty")}</p>}

        {resume.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-3 px-4 font-display text-lg font-semibold sm:px-8">{t("books.continue")}</h2>
            <div className="scrollbar-none flex snap-x gap-4 overflow-x-auto px-4 pb-2 sm:px-8">
              {resume.map((book) => (
                <button
                  key={book.id}
                  type="button"
                  onClick={(e) => open(book, e.currentTarget)}
                  className="group flex w-[17.5rem] shrink-0 snap-start items-center gap-4 rounded-2xl bg-white/5 p-3 text-left transition-transform duration-200 active:scale-[0.97] sm:w-[20rem]"
                >
                  <div data-book-cover className="w-20 shrink-0 overflow-hidden rounded-lg shadow-lg shadow-black/40">
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
                      <div className="h-full rounded-full bg-white" style={{ width: `${Math.round((book.progress?.fraction ?? 0) * 100)}%` }} />
                    </div>
                    <p className="mt-1.5 text-xs text-subtle">{t("books.percentRead", { pct: Math.round((book.progress?.fraction ?? 0) * 100) })}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {groups.map((group) => (
          <section key={group.key} className="mb-10">
            <div className="mb-3 flex items-baseline gap-3 px-4 sm:px-8">
              <h2 className="font-display text-lg font-semibold">{group.series ?? t("books.others")}</h2>
              {group.series && <span className="text-sm text-subtle">{group.books.length === 1 ? t("books.volumesOne") : t("books.volumes", { n: group.books.length })}</span>}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-6 px-4 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] sm:gap-x-5 sm:px-8 lg:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]">
              {group.books.map((book) => (
                <BookCard key={book.id} book={book} onOpen={open} />
              ))}
            </div>
          </section>
        ))}
      </main>

      {/* Portés dans `body`, comme le lecteur des films : sous l'écran, qui est `fixed` et donc son
          propre contexte d'empilement, la fiche et le lecteur passaient sous les invitations
          flottantes de l'application (« Installer », z-60) quel que soit leur propre z-index. */}
      {route.book &&
        createPortal(
          <BookSheet
            key={route.book}
            id={route.book}
            summary={selected}
            origin={origin?.id === route.book ? origin : null}
            hidden={route.reading}
            onRead={() => openBookRoute({ book: route.book, reading: true })}
            onClose={closeBookRoute}
          />,
          document.body
        )}
      {route.book &&
        route.reading &&
        createPortal(
          <BookReader
            key={route.book}
            id={route.book}
            title={selected ? displayTitle(selected) : ""}
            onClose={closeBookRoute}
            onSaved={() => void mutate()}
          />,
          document.body
        )}
    </div>
  );
}

function BookCard({ book, onOpen }: { book: BookSummary; onOpen: (book: BookSummary, el: HTMLElement) => void }) {
  const t = useT();
  const pct = book.progress && !book.progress.finished ? Math.round(book.progress.fraction * 100) : null;
  return (
    <button type="button" data-book-id={book.id} onClick={(e) => onOpen(book, e.currentTarget)} className="group text-left focus-visible:outline-none">
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
      {book.index !== null && book.seriesName && <p className="mt-0.5 text-xs text-subtle">{t("books.tome", { n: book.index })}</p>}
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-6 px-4 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] sm:gap-x-5 sm:px-8" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="aspect-[2/3] animate-pulse rounded-lg bg-surface" />
      ))}
    </div>
  );
}

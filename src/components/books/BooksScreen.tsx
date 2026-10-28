"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { ChevronLeft, Search, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { closeBookRoute, openBookRoute, useBookRoute } from "@/lib/books/bookRoute";
import { NO_SERIES, continueReading, filterBooks } from "@/lib/books/grouping";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";
import { BookCover } from "./BookCover";
import { BookSheet, type MorphOrigin } from "./BookSheet";
import { BooksGrid } from "./BooksGrid";

/**
 * La grille complète des livres (option, DECISIONS.md §127), « Tous les livres » : une recherche
 * (titre, série, auteur), le filtre d'une série venu de l'accueil (`?serie=`), « Continuer la
 * lecture » quand rien n'est filtré, puis toutes les séries dans l'ordre des tomes (`BooksGrid`,
 * dessinée par morceaux). La fiche et le lecteur
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

/** La série demandée dans l'adresse (`/livres?serie=…`, depuis le « Tout voir » d'une rangée de l'accueil). */
function serieFromAddress(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("serie");
  } catch {
    return null;
  }
}

export function BooksScreen() {
  const t = useT();
  const route = useBookRoute();
  const { data, error, isLoading, mutate } = useSWR<{ books: BookSummary[] }>(BOOKS_KEY, fetcher, { revalidateOnFocus: true });
  const books = useMemo(() => data?.books ?? [], [data]);
  const [serie, setSerie] = useState<string | null>(serieFromAddress);
  const [query, setQuery] = useState("");
  // La saisie reste vive ; le filtre de plusieurs milliers de livres suit juste derrière.
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => filterBooks(books, deferredQuery, serie), [books, deferredQuery, serie]);
  const filtering = deferredQuery.trim() !== "" || serie !== null;
  const resume = useMemo(() => (filtering ? [] : continueReading(books)), [books, filtering]);
  // Où la couverture touchée était à l'écran : la fiche en part (et y revient).
  const [origin, setOrigin] = useState<MorphOrigin | null>(null);

  const open = (book: BookSummary, el: HTMLElement) => {
    const cover = el.querySelector("[data-book-cover]") ?? el;
    setOrigin({ id: book.id, rect: cover.getBoundingClientRect() });
    openBookRoute({ book: book.id, reading: false });
  };
  const clearSerie = () => {
    setSerie(null);
    // L'adresse suit : un rechargement ne remettrait pas le filtre retiré.
    const url = new URL(window.location.href);
    url.searchParams.delete("serie");
    window.history.replaceState(window.history.state, "", url);
  };

  const selected = route.book ? (books.find((b) => b.id === route.book) ?? null) : null;
  const serieLabel = serie === NO_SERIES ? t("books.others") : serie;

  return (
    <div className="fixed inset-0 overflow-y-auto overscroll-contain bg-ink text-white" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <header className="sticky top-0 z-10 bg-gradient-to-b from-ink via-ink/95 to-ink/0 px-4 pb-5 pt-4 sm:px-8">
        <div className="flex items-center gap-3">
          {/* Un lien ordinaire : retour au document de l'accueil, et à sa politique de sécurité. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- un vrai chargement, exprès : la page des livres a sa propre politique de sécurité, qu'une navigation de Next garderait. */}
          <a href="/#livres=1" aria-label={t("books.back")} className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white">
            <ChevronLeft size={19} aria-hidden />
          </a>
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("books.browseAll")}</h1>
          {books.length > 0 && <span className="ml-auto text-sm text-subtle">{books.length === 1 ? t("books.countOne") : t("books.count", { n: books.length })}</span>}
        </div>
        {books.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-1 sm:max-w-md">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("books.searchPlaceholder")}
                aria-label={t("books.searchPlaceholder")}
                className="h-10 w-full rounded-full bg-white/10 pl-10 pr-4 text-sm text-white placeholder:text-subtle focus:bg-white/15 focus:outline-none"
                enterKeyHint="search"
              />
            </label>
            {serie !== null && (
              <button type="button" onClick={clearSerie} className="flex h-10 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-ink">
                {serieLabel}
                <X size={15} aria-label={t("books.clearFilter")} />
              </button>
            )}
          </div>
        )}
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
        {data && books.length > 0 && filtered.length === 0 && <p className="mx-auto mt-16 max-w-sm px-6 text-center text-muted">{t("books.noMatch")}</p>}

        {resume.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-3 px-4 font-display text-lg font-semibold sm:px-8">{t("books.continue")}</h2>
            <div className="scrollbar-none flex snap-x scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 sm:scroll-px-8 sm:px-8">
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

        {/* Remontée à chaque filtre : la grille repart de son premier morceau. */}
        <BooksGrid key={`${serie ?? ""}|${deferredQuery}`} books={filtered} onOpen={open} />
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

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-6 px-4 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] sm:gap-x-5 sm:px-8" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="aspect-[2/3] animate-pulse rounded-lg bg-surface" />
      ))}
    </div>
  );
}

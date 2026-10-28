"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { ChevronLeft, Search, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { closeBookRoute, openBookRoute, useBookRoute } from "@/lib/books/bookRoute";
import { BOOK_SORTS, NO_SERIES, authorIndex, continueReading, filterBooks, genreIndex, groupBooks, sortBooks, type BookSort } from "@/lib/books/grouping";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";
import { BookCover } from "./BookCover";
import { BookSheet, type MorphOrigin } from "./BookSheet";
import { BooksGrid } from "./BooksGrid";
import { BookRequestButton, BookRequestsPanel, useBookRequestsEnabled } from "./BookRequests";

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

/** Les filtres et le tri de l'adresse (`/livres?serie=…&auteur=…&genre=…&tri=…`) — le « Tout voir » des rangées y mène. */
function filtersFromAddress(): { serie: string | null; auteur: string | null; genre: string | null; tri: BookSort } {
  try {
    const p = new URLSearchParams(window.location.search);
    const tri = p.get("tri") as BookSort | null;
    return { serie: p.get("serie"), auteur: p.get("auteur"), genre: p.get("genre"), tri: tri && BOOK_SORTS.includes(tri) ? tri : "series" };
  } catch {
    return { serie: null, auteur: null, genre: null, tri: "series" };
  }
}

export function BooksScreen() {
  const t = useT();
  const route = useBookRoute();
  const { data, error, isLoading, mutate } = useSWR<{ books: BookSummary[] }>(BOOKS_KEY, fetcher, { revalidateOnFocus: true });
  const books = useMemo(() => data?.books ?? [], [data]);
  const [filters, setFilters] = useState(filtersFromAddress);
  const { serie, auteur, genre, tri } = filters;
  const [query, setQuery] = useState("");
  // La saisie reste vive ; le filtre de plusieurs milliers de livres suit juste derrière.
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(
    () => sortBooks(filterBooks(books, { query: deferredQuery, serie, auteur, genre }), tri),
    [books, deferredQuery, serie, auteur, genre, tri]
  );
  const filtering = deferredQuery.trim() !== "" || serie !== null || auteur !== null || genre !== null;
  // Les choix des filtres : chaque série, chaque auteur (rapproché), chaque genre de la bibliothèque.
  const choices = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    const sorted = (xs: string[]) => [...new Set(xs)].sort(collator.compare);
    return {
      series: sorted(groupBooks(books).flatMap((g) => (g.series ? [g.series] : []))),
      authors: sorted([...authorIndex(books).values()].map((a) => a.label)),
      genres: sorted([...genreIndex(books).values()].map((g) => g.label)),
    };
  }, [books]);
  const resume = useMemo(() => (filtering ? [] : continueReading(books)), [books, filtering]);
  // « Mes demandes » ouvert d'emblée : c'est là que mène la notification d'une demande (`?demandes=1`).
  const requestsEnabled = useBookRequestsEnabled();
  const [requestsOpen, setRequestsOpen] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("demandes") === "1";
    } catch {
      return false;
    }
  });
  // Où la couverture touchée était à l'écran : la fiche en part (et y revient).
  const [origin, setOrigin] = useState<MorphOrigin | null>(null);

  const open = (book: BookSummary, el: HTMLElement) => {
    const cover = el.querySelector("[data-book-cover]") ?? el;
    setOrigin({ id: book.id, rect: cover.getBoundingClientRect() });
    openBookRoute({ book: book.id, reading: false });
  };
  const setFilter = (key: "serie" | "auteur" | "genre" | "tri", value: string | null) => {
    setFilters((f) => ({ ...f, [key]: key === "tri" ? ((value as BookSort | null) ?? "series") : value || null }));
    // L'adresse suit : un rechargement, un retour, un lien gardé retrouvent la même grille.
    const url = new URL(window.location.href);
    if (value && !(key === "tri" && value === "series")) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
  };

  const selected = route.book ? (books.find((b) => b.id === route.book) ?? null) : null;

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
            <BookRequestButton books={books} />
          </div>
        )}
        {books.length > 0 && (
          <div className="scrollbar-none -mx-4 mt-2 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
            <Picker label={t("books.sortBy")} value={tri} onChange={(v) => setFilter("tri", v)} options={BOOK_SORTS.map((s) => ({ value: s, label: t(`books.sorts.${s}`) }))} />
            <Picker
              label={t("books.filterSeries")}
              value={serie ?? ""}
              onChange={(v) => setFilter("serie", v)}
              options={[{ value: "", label: t("books.filterSeries") }, ...choices.series.map((x) => ({ value: x, label: x })), { value: NO_SERIES, label: t("books.others") }]}
            />
            <Picker label={t("books.filterAuthor")} value={auteur ?? ""} onChange={(v) => setFilter("auteur", v)} options={[{ value: "", label: t("books.filterAuthor") }, ...choices.authors.map((x) => ({ value: x, label: x }))]} />
            {choices.genres.length > 0 && (
              <Picker label={t("books.filterGenre")} value={genre ?? ""} onChange={(v) => setFilter("genre", v)} options={[{ value: "", label: t("books.filterGenre") }, ...choices.genres.map((x) => ({ value: x, label: x }))]} />
            )}
            {(serie || auteur || genre) && (
              <button
                type="button"
                onClick={() => {
                  setFilter("serie", null);
                  setFilter("auteur", null);
                  setFilter("genre", null);
                }}
                className="flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-sm text-subtle hover:text-white"
              >
                <X size={14} aria-hidden /> {t("books.clearFilter")}
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
        {data && books.length > 0 && filtered.length === 0 && (
          <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <p className="text-muted">{t("books.noMatch")}</p>
            {/* La recherche vide mène à la demande, le titre déjà tapé. */}
            <BookRequestButton books={books} label={t("books.requests.notFound")} initialTitle={deferredQuery.trim()} />
          </div>
        )}

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
        <BooksGrid key={`${serie ?? ""}|${auteur ?? ""}|${genre ?? ""}|${tri}|${deferredQuery}`} books={filtered} onOpen={open} flat={tri !== "series"} />
      </main>

      {requestsEnabled && requestsOpen && <BookRequestsPanel books={books} onClose={() => setRequestsOpen(false)} />}

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

/** Un choix de la grille, en liste native : des milliers d'auteurs s'y parcourent au clavier comme au doigt. */
function Picker({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const active = value !== "" && value !== "series";
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-9 max-w-[14rem] shrink-0 cursor-pointer appearance-none truncate rounded-full px-4 text-sm font-medium focus:outline-none ${active ? "bg-white text-ink" : "bg-white/10 text-white"}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-surface text-white">
          {o.label}
        </option>
      ))}
    </select>
  );
}

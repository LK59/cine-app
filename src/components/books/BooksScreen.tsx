"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { lazyNow } from "./lazyNow";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { ChevronLeft } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { cinemaClose, cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";
import { readerOpening } from "@/lib/books/readerOpening";
import { preloadBookFile } from "@/lib/books/readerPreload";
import { BOOKS_PROGRESS_EVENT, acceptFromParent, insetValue, isFramedReader, tellCinema } from "@/lib/books/readerFrame";
import { BOOK_SORTS, NO_SERIES, type BookSort } from "@/lib/books/grouping";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";
import { BookCover } from "./BookCover";
import { BookSheetHost } from "./BookSheet";
import { BooksGrid, GRID_CHUNK } from "./BooksGrid";
import { BookRequestButton, BookRequestsPanel, useBookRequestsEnabled } from "./BookRequests";

/**
 * La grille complète des livres (option, DECISIONS.md §127), « Tous les livres » : une recherche
 * (titre, série, auteur), le filtre d'une série venu de l'accueil (`?serie=`), « Continuer la
 * lecture » quand rien n'est filtré, puis toutes les séries dans l'ordre des tomes (`BooksGrid`,
 * dessinée par morceaux). La fiche et le lecteur
 * s'ouvrent par-dessus, chacun avec son entrée d'historique — l'adresse et le cycle de vie des fiches
 * de films (`cinemaRoute`, `BookSheetHost`).
 *
 * Le lecteur est un morceau à part, chargé à la première ouverture d'un livre : la grille ne
 * télécharge rien de foliate-js.
 */
const BookReader = lazyNow(
  () => import("./BookReader").then((m) => m.BookReader),
  <div className="fixed inset-0 z-[300] flex items-center justify-center bg-ink">
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
  </div>
);

export const BOOKS_KEY = "/api/books";
const QUERY_DEBOUNCE_MS = 250;
const EMPTY: BookSummary[] = [];
const NO_FACETS = { series: [] as string[], authors: [] as string[], genres: [] as string[] };

interface BooksPage {
  total: number;
  library: number;
  books: BookSummary[];
  seriesCounts: Record<string, number>;
  resume?: BookSummary[];
}

type Filters = { serie: string | null; auteur: string | null; genre: string | null; tri: BookSort };

/** Les filtres et le tri (`serie=…&auteur=…&genre=…&tri=…`) — de l'adresse de la page, ou de `#tous=…` dans le cinéma. */
function filtersFrom(p: URLSearchParams): Filters {
  const tri = p.get("tri") as BookSort | null;
  return { serie: p.get("serie"), auteur: p.get("auteur"), genre: p.get("genre"), tri: tri && BOOK_SORTS.includes(tri) ? tri : "series" };
}
function filtersFromAddress(): Filters {
  try {
    return filtersFrom(new URLSearchParams(window.location.search));
  } catch {
    return { serie: null, auteur: null, genre: null, tri: "series" };
  }
}
function filtersToString(f: Filters): string {
  const p = new URLSearchParams();
  if (f.serie) p.set("serie", f.serie);
  if (f.auteur) p.set("auteur", f.auteur);
  if (f.genre) p.set("genre", f.genre);
  if (f.tri !== "series") p.set("tri", f.tri);
  return p.toString();
}

/**
 * `embedded` : la grille ouverte par-dessus l'accueil du cinéma (`#tous=…`, `BooksHome`), sans changer de
 * page. Ses filtres vivent alors dans l'adresse du cinéma ; « Lire » ouvre le lecteur dans un cadre comme
 * depuis l'accueil (`openReaderFrame`), et le retour la referme d'un pas d'historique.
 *
 * La page est aussi ce cadre (`?cadre=1`, §128) : le lecteur seul, qui ne touche pas à l'historique de la
 * fenêtre du dessus — il dit au cinéma qu'il est prêt, qu'une position est enregistrée, qu'il faut
 * refermer (`tellCinema`), et reçoit de lui les marges de l'écran.
 */
export function BooksScreen({ embedded }: { embedded?: { filter: string; onRead: (id: string, cover: HTMLElement | null) => void } } = {}) {
  const t = useT();
  const route = useCinemaRoute();
  const [filters, setFilters] = useState<Filters>(() => (embedded ? filtersFrom(new URLSearchParams(embedded.filter === "1" ? "" : embedded.filter)) : filtersFromAddress()));
  const [framed] = useState(() => !embedded && isFramedReader());
  // Arrivé de l'accueil du cinéma pour lire (`?retour=1`, une adresse d'avant le cadre gardée quelque part),
  // ou le cadre posé sur le cinéma : la grille n'est pas montrée — refermer le lecteur ramène au cinéma.
  // Ses pages ne sont pas demandées, le lecteur a le réseau pour lui seul.
  const [readerOnly] = useState(() => {
    try {
      return !embedded && (framed || new URLSearchParams(window.location.search).get("retour") === "1") && /(?:^#|&)lire=1(?:&|$)/.test(window.location.hash);
    } catch {
      return false;
    }
  });
  // Dans le cadre : les marges de l'écran viennent du cinéma (un cadre n'a pas celles de l'encoche ni de la
  // barre d'accueil), posées en variables que le lecteur lit avant `env()` (`insetVar`). Puis `hello` : le
  // cinéma répond dès que cette écoute existe, pas avant.
  useEffect(() => {
    if (!framed || !route.book) return;
    const book = route.book;
    const onMessage = (event: MessageEvent) => {
      const msg = acceptFromParent(event, window.parent, window.location.origin);
      if (!msg) return;
      const root = document.documentElement.style;
      for (const side of ["top", "right", "bottom", "left"] as const) root.setProperty(`--reader-inset-${side}`, insetValue(msg[side], side));
    };
    window.addEventListener("message", onMessage);
    tellCinema("hello", book);
    return () => window.removeEventListener("message", onMessage);
  }, [framed, route.book]);
  // Le fichier et le code du lecteur demandés dès le premier rendu, pas après le code de la page puis
  // celui du lecteur (`readerPreload.ts`, mesuré le 28/10/2026).
  useEffect(() => {
    if (embedded || !route.book || !route.reading) return;
    void preloadBookFile(route.book);
    void BookReader.preload().catch(() => {});
    void import("@/lib/books/foliate/view.js").catch(() => {});
  }, [embedded, route.book, route.reading]);
  const { serie, auteur, genre, tri } = filters;
  const [query, setQuery] = useState("");
  // Le filtre tapé part au serveur un quart de seconde après la dernière frappe, pas à chaque lettre.
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setTyped(query.trim()), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (typed) p.set("q", typed);
    if (serie) p.set("serie", serie);
    if (auteur) p.set("auteur", auteur);
    if (genre) p.set("genre", genre);
    if (tri !== "series") p.set("tri", tri);
    return p.toString();
  }, [typed, serie, auteur, genre, tri]);
  // La grille par pages (`/api/books?offset=…`) : la bibliothèque entière ne voyage jamais d'un bloc.
  const { data: pages, error, isLoading, isValidating, setSize, mutate } = useSWRInfinite<BooksPage>(
    (i, previous: BooksPage | null) =>
      readerOnly || (previous && previous.books.length < GRID_CHUNK) ? null : `${BOOKS_KEY}?${params}${params ? "&" : ""}offset=${i * GRID_CHUNK}&limit=${GRID_CHUNK}`,
    fetcher,
    { revalidateFirstPage: false, revalidateOnFocus: false }
  );
  const data = pages?.[0];
  const books = useMemo(() => pages?.flatMap((page) => page.books) ?? [], [pages]);
  const seriesCounts = useMemo(() => Object.assign({}, ...(pages ?? []).map((page) => page.seriesCounts)) as Record<string, number>, [pages]);
  const total = data?.total ?? 0;
  const library = data?.library ?? 0;
  const more = books.length < total;
  const loadMore = useCallback(() => {
    if (!isValidating) void setSize((n) => n + 1);
  }, [isValidating, setSize]);
  // Dans le cinéma, la grille ouverte par-dessus l'accueil relit ses pages quand le lecteur du cadre a
  // enregistré une position (`ReaderFrame`) : « Continuer la lecture » et les pourcentages suivent.
  useEffect(() => {
    if (!embedded) return;
    const onProgress = () => void mutate();
    window.addEventListener(BOOKS_PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(BOOKS_PROGRESS_EVENT, onProgress);
  }, [embedded, mutate]);
  const filtering = typed !== "" || serie !== null || auteur !== null || genre !== null;
  // Les choix des menus, calculés par le serveur une fois (`/api/books/facets`).
  const { data: facets } = useSWR<{ series: string[]; authors: string[]; genres: string[] }>(readerOnly ? null : "/api/books/facets", fetcher);
  const choices = facets ?? NO_FACETS;
  const resume = filtering ? EMPTY : (data?.resume ?? EMPTY);
  // « Mes demandes » ouvert d'emblée : c'est là que mène la notification d'une demande (`?demandes=1`).
  const requestsEnabled = useBookRequestsEnabled();
  const [requestsOpen, setRequestsOpen] = useState(() => {
    try {
      return !embedded && new URLSearchParams(window.location.search).get("demandes") === "1";
    } catch {
      return false;
    }
  });
  // La fiche s'ouvre d'une entrée d'historique, comme celle d'un film ; d'où elle part, c'est l'appui
  // lui-même qui le dit (`sheetMorph/source.ts`), la carte n'a rien à transmettre.
  const open = (book: BookSummary) => cinemaNavigate({ book: book.id, reading: false });
  // Le lecteur : la couverture grandit en première page (`readerOpening`), puis l'adresse le nomme.
  const openReader = async (_book: BookSummary | null, _id: string, cover: HTMLElement | null) => {
    const done = await readerOpening(cover);
    cinemaNavigate({ reading: true });
    window.setTimeout(done, 450);
  };
  /**
   * Refermer le lecteur : un retour, comme une fiche. Arrivé directement de l'accueil du cinéma
   * (`?retour=1`, `BooksHome`), sans rien d'empilé ici, c'est à l'accueil qu'on revient — où la fiche
   * du livre attend. Dans le cadre posé sur le cinéma, c'est le cinéma qui referme : le cadre le lui
   * demande, sans toucher à l'historique.
   */
  const closeReader = () => {
    if (framed) {
      if (route.book) tellCinema("close", route.book);
      return;
    }
    const fromHome = new URLSearchParams(window.location.search).get("retour") === "1";
    const depth = (window.history.state as Record<string, unknown> | null)?.cinemaDepth;
    if (fromHome && !(typeof depth === "number" && depth > 0)) {
      let sameSite = false;
      try {
        sameSite = new URL(document.referrer).origin === window.location.origin;
      } catch {
        /* pas de provenance lisible */
      }
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- un vrai chargement, exprès : l'accueil a sa propre politique de sécurité.
      if (!sameSite) window.location.assign(`/#livres=1&livre=${route.book ?? ""}`);
      else window.history.back();
      return;
    }
    cinemaClose({ reading: false });
  };
  const setFilter = (key: "serie" | "auteur" | "genre" | "tri", value: string | null) => {
    const next: Filters = { ...filters, [key]: key === "tri" ? ((value as BookSort | null) ?? "series") : value || null };
    setFilters(next);
    if (embedded) {
      // Dans le cinéma, l'adresse du cinéma suit (`#tous=…`) : un retour ou un rechargement retrouvent la même grille.
      cinemaNavigate({ booksAll: filtersToString(next) || "1" }, "replace");
      return;
    }
    // L'adresse suit : un rechargement, un retour, un lien gardé retrouvent la même grille.
    const url = new URL(window.location.href);
    if (value && !(key === "tri" && value === "series")) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
  };

  const known = useMemo(() => [...resume, ...books], [resume, books]);
  const listed = route.book ? (known.find((b) => b.id === route.book) ?? null) : null;
  // Un livre ouvert hors des pages reçues (depuis l'accueil, la recherche) : sa fiche le dit — la même clé que celle de `BookSheet`.
  const { data: detail } = useSWR<BookSummary>(route.book && !listed ? `/api/books/${route.book}` : null, fetcher);
  const selected = listed ?? detail ?? null;

  // Dans le cinéma, Échap referme la grille — pas quand une fiche est ouverte par-dessus, qui a le sien.
  useEffect(() => {
    if (!embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !route.book && !e.defaultPrevented) cinemaClose({ booksAll: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, route.book]);

  if (readerOnly && route.book && route.reading) {
    const book = route.book;
    return createPortal(
      <BookReader
        key={book}
        id={book}
        title={selected ? displayTitle(selected) : ""}
        onClose={closeReader}
        onSaved={() => {
          void mutate();
          if (framed) tellCinema("saved", book);
        }}
        onReady={framed ? () => tellCinema("ready", book) : undefined}
      />,
      document.body
    );
  }

  return (
    <div
      className={`fixed inset-0 overflow-y-auto overscroll-contain bg-ink text-white ${embedded ? "z-[47]" : ""}`}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      data-books-browse={embedded ? "" : undefined}
      // Sous une fiche, la grille ne répond plus (la règle des fiches de films).
      inert={embedded && !!route.book}
    >
      <header className="sticky top-0 z-10 bg-gradient-to-b from-ink via-ink/95 to-ink/0 px-4 pb-5 pt-4 sm:px-8">
        <div className="flex items-center gap-3">
          {embedded ? (
            <button type="button" onClick={() => cinemaClose({ booksAll: null })} aria-label={t("books.back")} className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white">
              <ChevronLeft size={19} aria-hidden />
            </button>
          ) : (
            // Un lien ordinaire : retour au document de l'accueil, et à sa politique de sécurité.
            // eslint-disable-next-line @next/next/no-html-link-for-pages -- un vrai chargement, exprès : la page des livres a sa propre politique de sécurité, qu'une navigation de Next garderait.
            <a href="/#livres=1" aria-label={t("books.back")} className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white">
              <ChevronLeft size={19} aria-hidden />
            </a>
          )}
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("books.browseAll")}</h1>
          {data && total > 0 && <span className="ml-auto text-sm text-subtle">{total === 1 ? t("books.countOne") : t("books.count", { n: total })}</span>}
        </div>
        {library > 0 && (
          // Les réglages de la grille, comme ceux de « Voir tout » des films (`CinemaBrowseSheet`) : une
          // ligne qui défile — le filtre de la grille (pas une seconde recherche : celle de l'application
          // trouve aussi les livres), le tri, le genre, l'auteur, la série — mêmes champs, mêmes libellés.
          <div className="relative -mx-1 mt-3">
            <div className="scrollbar-none flex gap-2 overflow-x-auto px-1 pb-1">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
                placeholder={t("player.browse.filter")}
                aria-label={t("player.browse.filter")}
                className={`${FILTER_FIELD} w-40`}
              />
              <Picker label={t("player.browse.sort")} value={tri} onChange={(v) => setFilter("tri", v)} options={BOOK_SORTS.map((s) => ({ value: s, label: t(`books.sorts.${s}`) }))} />
              {choices.genres.length > 0 && (
                <Picker label={t("player.browse.genre")} value={genre ?? ""} onChange={(v) => setFilter("genre", v)} options={[{ value: "", label: t("player.browse.allGenres") }, ...choices.genres.map((x) => ({ value: x, label: x }))]} />
              )}
              <Picker label={t("books.filterAuthor")} value={auteur ?? ""} onChange={(v) => setFilter("auteur", v)} options={[{ value: "", label: t("books.allAuthors") }, ...choices.authors.map((x) => ({ value: x, label: x }))]} />
              <Picker
                label={t("books.filterSeries")}
                value={serie ?? ""}
                onChange={(v) => setFilter("serie", v)}
                options={[{ value: "", label: t("books.allSeries") }, ...choices.series.map((x) => ({ value: x, label: x })), { value: NO_SERIES, label: t("books.others") }]}
              />
              <BookRequestButton className="h-9 shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 text-sm font-medium text-white hover:bg-white/10" />
            </div>
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
        {data && library === 0 && <p className="mx-auto mt-24 max-w-sm px-6 text-center text-muted">{t("books.empty")}</p>}
        {data && library > 0 && total === 0 && (

          <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <p className="text-muted">{t("books.noMatch")}</p>
            {/* La recherche vide mène à la demande, le titre déjà tapé. */}
            <BookRequestButton label={t("books.requests.notFound")} initialTitle={typed} />
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
                  data-sheet-source=""
                  onClick={() => open(book)}
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
        <BooksGrid key={params} books={books} onOpen={open} flat={tri !== "series"} more={more} onMore={loadMore} seriesCounts={seriesCounts} />
      </main>

      {requestsEnabled && requestsOpen && <BookRequestsPanel onClose={() => setRequestsOpen(false)} />}

      {/* La fiche d'après l'adresse, dans le cycle de vie des fiches de films (`BookSheetHost`). */}
      <BookSheetHost books={known} onRead={embedded ? (_book, id, cover) => embedded.onRead(id, cover) : openReader} />
      {/* Porté dans `body`, comme le lecteur des films : sous l'écran, qui est `fixed` et donc son
          propre contexte d'empilement, il passait sous les invitations flottantes de l'application
          (« Installer », z-60) quel que soit son propre z-index. */}
      {!embedded &&
        route.book &&
        route.reading &&
        createPortal(
          <BookReader key={route.book} id={route.book} title={selected ? displayTitle(selected) : ""} onClose={closeReader} onSaved={() => void mutate()} />,
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

// Les champs de « Voir tout » des films (`CinemaBrowseSheet`, `FILTER_BASE`), recopiés : sans le flou
// d'arrière-plan des `input` / `select` globaux, qui accrochait le défilement sur iPhone.
const FILTER_BASE =
  "h-9 shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500";
const FILTER_FIELD = `${FILTER_BASE} placeholder:text-subtle`;

/** Un choix de la grille, en liste native : des milliers d'auteurs s'y parcourent au clavier comme au doigt. */
function Picker({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={`${FILTER_BASE} max-w-[14rem]`}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

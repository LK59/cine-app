"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { continueReading, groupBooks } from "@/lib/books/grouping";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";
import { BookCover } from "./BookCover";

/**
 * L'accueil de la catégorie Livres (option, DECISIONS.md §127), à la place des rangées de films ou
 * de séries : « Continuer la lecture », puis une rangée par série dans l'ordre des tomes, puis les
 * autres livres. Pas de bannière : une couverture n'est pas une image de fond, et le carrousel des
 * films et séries n'est pas touché.
 *
 * Un livre touché ouvre sa fiche sur la page des livres (`/livres`), par un vrai chargement : le
 * lecteur affiche ses chapitres dans des cadres `blob:` que seule la politique de sécurité de cette
 * page permet. `retour=1` : y fermer la fiche ramène ici plutôt qu'à la grille complète.
 */
export function openBookFromHome(id: string): void {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- un vrai chargement, exprès (politique de la page des livres).
  window.location.assign(`/livres?retour=1#livre=${id}`);
}

export function BooksHome({ variant }: { variant: "desktop" | "mobile" }) {
  const t = useT();
  const { data, error, isLoading, mutate } = useSWR<{ books: BookSummary[] }>("/api/books", fetcher, { revalidateOnFocus: true });
  const books = useMemo(() => data?.books ?? [], [data]);
  const groups = useMemo(() => groupBooks(books), [books]);
  const resume = useMemo(() => continueReading(books), [books]);
  const desktop = variant === "desktop";
  const pad = desktop ? "px-8 lg:px-12" : "px-4";
  const card = desktop ? "w-36 lg:w-40" : "w-28";

  return (
    <div
      className={desktop ? "absolute inset-y-0 right-0 z-[9] overflow-y-auto bg-ink pb-16" : "flex-1 overflow-y-auto overscroll-contain"}
      style={
        desktop
          ? { left: "var(--player-rail, 0px)", paddingTop: "calc(max(1rem, env(safe-area-inset-top)) + 4.5rem)" }
          : { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 6rem)" }
      }
      data-books-home
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
      {data && books.length === 0 && <p className="mx-auto mt-24 max-w-sm px-6 text-center text-muted">{t("books.empty")}</p>}

      {resume.length > 0 && (
        <section className="mb-8">
          <h2 className={`${pad} mb-3 font-display text-lg font-semibold`}>{t("books.continue")}</h2>
          <div className={`${pad} scrollbar-none flex snap-x gap-4 overflow-x-auto pb-2`}>
            {resume.map((book) => {
              const pct = Math.round((book.progress?.fraction ?? 0) * 100);
              return (
                <button
                  key={book.id}
                  type="button"
                  onClick={() => openBookFromHome(book.id)}
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

      {groups.map((group) => (
        <section key={group.key} className="mb-8">
          <div className={`${pad} mb-3 flex items-baseline gap-3`}>
            <h2 className="font-display text-lg font-semibold">{group.series ?? t("books.others")}</h2>
            {group.series && <span className="text-sm text-subtle">{group.books.length === 1 ? t("books.volumesOne") : t("books.volumes", { n: group.books.length })}</span>}
            <a href="/livres" className="ml-auto text-sm text-subtle transition-colors hover:text-white">
              {t("books.seeAll")}
            </a>
          </div>
          <div className={`${pad} scrollbar-none flex snap-x gap-3 overflow-x-auto pb-2 ${desktop ? "gap-4" : ""}`}>
            {group.books.map((book) => {
              const pct = book.progress && !book.progress.finished ? Math.round(book.progress.fraction * 100) : 0;
              return (
                <button key={book.id} type="button" onClick={() => openBookFromHome(book.id)} className={`group ${card} shrink-0 snap-start text-left`}>
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
      ))}
    </div>
  );
}

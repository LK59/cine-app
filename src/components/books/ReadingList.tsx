"use client";

import { useMemo } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { BookMarked, BookmarkMinus, BookmarkPlus } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { NOT_THE_HANDLE } from "@/lib/useSwipeToDismiss";
import { filterByTitle, sortList, type ListSort } from "@/lib/playerListSort";
import type { BookSummary } from "@/lib/books/types";
import { PlayerEmptyState } from "@/components/player/PlayerEmptyState";
import { BookCard } from "./BooksGrid";

/**
 * « Ma liste de lecture » côté écran (DECISIONS.md §129) : le bouton de la fiche d'un livre, et le
 * segment « À lire » de Ma liste. Les deux lisent la même clé (`READING_LIST_KEY`), une seule réponse du
 * serveur : la liste du compte, filtrée par sa vue de l'index. Chargé seulement là où les livres sont
 * affichés pour ce compte (la fiche d'un livre, ou `BooksMode` pour Ma liste) — jamais par le cinéma seul.
 */

export const READING_LIST_KEY = "/api/books/list";

export type ListedBook = BookSummary & { listedAt: number };

export function useReadingList(): { books: ListedBook[] | undefined; error: unknown; isLoading: boolean; retry: () => void } {
  const { data, error, isLoading, mutate } = useSWR<{ books: ListedBook[] }>(READING_LIST_KEY, fetcher, { revalidateOnFocus: false });
  return { books: data?.books, error, isLoading, retry: () => void mutate() };
}

/**
 * Ajouter ou retirer, **avant** la réponse : la liste montrée change aussitôt, et revient en arrière si le
 * serveur refuse (un livre que le compte ne voit plus, la liste pleine). L'accueil des livres relit sa
 * rangée « Ma liste de lecture » ensuite.
 */
export async function setListed(book: BookSummary, listed: boolean): Promise<void> {
  await globalMutate<{ books: ListedBook[] }>(
    READING_LIST_KEY,
    async (current) => {
      const res = listed
        ? await fetch(READING_LIST_KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: book.id }) })
        : await fetch(`${READING_LIST_KEY}?id=${encodeURIComponent(book.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      return toggled(current, book, listed);
    },
    { optimisticData: (current) => toggled(current, book, listed), rollbackOnError: true, revalidate: false }
  );
  void globalMutate("/api/books/home");
}

function toggled(current: { books: ListedBook[] } | undefined, book: BookSummary, listed: boolean): { books: ListedBook[] } {
  const rest = (current?.books ?? []).filter((b) => b.id !== book.id);
  return { books: listed ? [{ ...book, listedAt: Date.now() }, ...rest] : rest };
}

/** Le bouton de la fiche : « Ajouter à ma liste de lecture » / « Retirer de ma liste de lecture ». */
export function ReadingListButton({ book, finished }: { book: BookSummary; finished: boolean }) {
  const t = useT();
  const { books } = useReadingList();
  const listed = books?.some((b) => b.id === book.id) ?? false;
  // Un livre terminé sort de la liste de lui-même : on ne propose pas de l'y mettre, seulement de l'en retirer.
  if (books === undefined || (finished && !listed)) return null;
  const Icon = listed ? BookmarkMinus : BookmarkPlus;
  return (
    <button
      type="button"
      {...NOT_THE_HANDLE}
      aria-pressed={listed}
      onClick={() => void setListed(book, !listed).catch(() => {})}
      className="flex items-center gap-1.5 text-sm text-subtle transition-colors hover:text-white"
      data-reading-list-toggle=""
    >
      <Icon size={15} aria-hidden /> {listed ? t("books.list.remove") : t("books.list.add")}
    </button>
  );
}

/**
 * Le segment « À lire » de Ma liste : la recherche et le tri de la liste s'y appliquent comme aux films
 * (`filterByTitle`, `sortList` — « Date d'ajout » est la date d'ajout à la liste). Un livre touché ouvre
 * sa fiche dans la catégorie Livres, par-dessus Ma liste : Retour y ramène, comme depuis la recherche.
 */
export function ReadingListSegment({ query, sort }: { query: string; sort: ListSort }) {
  const t = useT();
  const { books, error, isLoading, retry } = useReadingList();
  const shown = useMemo(() => {
    // Filtré sur le nom entier, comme le compteur de l'onglet (`useReadingListEntry`) : les deux disent le même nombre.
    const items = (books ?? []).map((b) => ({ ...b, title: b.name, addedAt: b.listedAt }));
    return sortList(filterByTitle(items, query), sort);
  }, [books, query, sort]);

  if (isLoading && !books) {
    return (
      <div className="mt-12 flex justify-center">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    );
  }
  if (error !== undefined && !books) return <PlayerEmptyState icon={BookMarked} message={t("player.lists.failed")} action={{ label: t("common.retry"), onClick: retry }} />;
  if (shown.length === 0) {
    return (
      <PlayerEmptyState
        icon={BookMarked}
        message={t("books.list.empty")}
        action={{ label: t("books.list.browse"), onClick: () => cinemaNavigate({ list: false, books: true, book: null, reading: false }) }}
      />
    );
  }
  return (
    <div className="mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6" data-reading-list="">
      {shown.map((b) => (
        <BookCard key={b.id} book={b} onOpen={(book) => cinemaNavigate({ books: true, book: book.id, reading: false })} />
      ))}
    </div>
  );
}

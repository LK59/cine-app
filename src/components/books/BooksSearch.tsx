"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";
import { PlayerResultCard } from "@/components/player/PlayerResultCard";
import { coverUrl } from "./BookCover";

/** Le temps de laisser finir la frappe : une requête par pause, pas par lettre. */
export const BOOKS_SEARCH_DEBOUNCE_MS = 300;

/**
 * Les livres dans la recherche de l'application (option, DECISIONS.md §127) : une section « Livres »
 * sous les films et les séries. **Sa propre requête** (`/api/books/search`, douze résultats au plus,
 * tirés de l'index en mémoire du serveur), partie un temps après la dernière frappe : les résultats des
 * films et séries ne l'attendent jamais, et rien n'est dessiné tant qu'elle n'a pas répondu. Les cartes
 * de résultat de la recherche elle-même (`PlayerResultCard`). Un livre touché ouvre sa fiche dans la
 * catégorie Livres de l'accueil, par une entrée d'historique : Retour revient à la recherche.
 */
export function BooksSearch({ query }: { query: string }) {
  const t = useT();
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(query.trim()), BOOKS_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const key = settled.length >= 2 ? `/api/books/search?q=${encodeURIComponent(settled)}` : null;
  // Pas de `keepPreviousData` : une recherche qui change ne montre pas les livres de la précédente.
  const { data } = useSWR<{ books: BookSummary[] }>(key, fetcher, { keepPreviousData: false, revalidateOnFocus: false });
  const results = key && data ? data.books : [];
  if (results.length === 0) return null;
  return (
    <section className="mt-8" data-books-search>
      <h2 className="mb-3 text-sm font-semibold text-white">{t("books.nav")}</h2>
      <div className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 player-grid-fluid">
        {results.map((b) => (
          <PlayerResultCard
            key={b.id}
            kind="movie"
            showKind={false}
            title={displayTitle(b)}
            subtitle={b.authors[0] ?? (b.year ? String(b.year) : null)}
            poster={coverUrl(b)}
            onOpen={() => cinemaNavigate({ books: true, book: b.id, reading: false })}
          />
        ))}
      </div>
    </section>
  );
}

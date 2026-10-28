"use client";

import { useEffect } from "react";
import { BookOpen } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { bookAccount, loadOfflineBooks, rememberedBookAccount, useOfflineBooks, warmOfflineBooksPage, OFFLINE_BOOKS_PATH } from "@/lib/books/offlineBooks";
import { OfflineBookCard } from "./OfflineBooksScreen";

/**
 * Les livres gardés sur l'appareil, dans la page des téléchargements (DECISIONS.md §127) : leur propre
 * section, sous les films et les séries. Un livre touché s'ouvre dans la page hors ligne des livres
 * (`/livres/hors-ligne`), la seule qui lise sans réseau — avec ou sans, c'est la même. Le retirer de
 * l'appareil se fait d'ici.
 */
export function BooksDownloads() {
  const t = useT();
  const { books } = useOfflineBooks();
  useEffect(() => {
    let cancelled = false;
    const remembered = rememberedBookAccount();
    void loadOfflineBooks(remembered).then(async () => {
      const live = await bookAccount();
      if (!cancelled && live && live !== remembered) await loadOfflineBooks(live);
    });
    // Une page des téléchargements ouverte sur un appareil qui garde des livres : la page hors ligne des
    // livres doit l'être aussi, pour le jour où le réseau manque.
    warmOfflineBooksPage();
    return () => {
      cancelled = true;
    };
  }, []);
  if (books.length === 0) return null;
  return (
    <section data-downloads-books>
      <h2 className="mb-2.5 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-subtle">
        <BookOpen size={13} aria-hidden />
        {t("books.downloadsSection")}
      </h2>
      <ul className="player-grid grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5">
        {books.map((b) => (
          <li key={b.id}>
            <OfflineBookCard
              book={b}
              onOpen={() => {
                // Un vrai chargement : le lecteur ne vit que sous la politique de sécurité des livres.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- un vrai chargement, exprès (politique de la page des livres).
                window.location.assign(`${OFFLINE_BOOKS_PATH}#livre=${b.id}`);
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

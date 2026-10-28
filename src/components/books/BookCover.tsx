"use client";

import { useState } from "react";
import { BookOpen } from "lucide-react";
import type { BookSummary } from "@/lib/books/types";

/**
 * La couverture d'un livre, par le relais d'images de l'application (`/api/jellyfin/image`, qui
 * vérifie que le compte voit l'élément). `kind=poster` : 500 px de large, net sur une carte de 160 px
 * d'un écran ×3. Avec son empreinte (`tag`), l'image est gardée un an et ne se revalide jamais.
 *
 * Sans couverture (Jellyfin n'en a pas trouvé dans l'EPUB), ou si elle ne se charge pas : le titre
 * sur une surface, à la même proportion — la grille ne saute pas.
 */
export function coverUrl(book: Pick<BookSummary, "id" | "coverTag">): string | null {
  if (!book.coverTag) return null;
  return `/api/jellyfin/image?itemId=${book.id}&tag=${encodeURIComponent(book.coverTag)}&kind=poster`;
}

export function BookCover({ book, className = "", eager = false }: { book: BookSummary; className?: string; eager?: boolean }) {
  const url = coverUrl(book);
  const [failed, setFailed] = useState(false);
  return (
    <div className={`relative aspect-[2/3] overflow-hidden bg-surface ${className}`}>
      {url && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- relais d'images déjà dimensionné par Jellyfin ; l'optimiseur le recompresserait pour rien.
        <img
          src={url}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
          <BookOpen size={22} className="text-subtle" aria-hidden />
          <span className="line-clamp-4 font-display text-sm font-semibold text-muted">{book.name}</span>
        </div>
      )}
      {/* Le relief d'un dos de livre : une ombre fine à gauche, un reflet à peine visible. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-black/30 to-transparent" aria-hidden />
    </div>
  );
}

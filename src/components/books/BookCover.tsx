"use client";

import { useState } from "react";
import type { BookSummary } from "@/lib/books/types";
import { displayTitle } from "@/lib/books/displayTitle";

/**
 * La couverture d'un livre (DECISIONS.md §127), dans cet ordre :
 *
 * 1. celle de Jellyfin, par le relais d'images de l'application (`/api/jellyfin/image`, qui vérifie que
 *    le compte voit l'élément) — `kind=poster`, 500 px, gardée un an avec son empreinte ;
 * 2. sinon celle de l'EPUB, faite par le serveur à la première demande (`/api/books/<id>/cover`) ;
 * 3. sinon — ou tant qu'elle arrive — une couverture dessinée : le titre et l'auteur sur une couleur
 *    tirée du titre. Jamais une tuile grise : une bibliothèque où un tiers des livres n'a pas d'image
 *    ressemblerait sinon à un trou sur trois.
 *
 * Toujours à la même proportion (2/3), l'image chargée à l'approche (`loading="lazy"`) et décodée hors
 * du fil principal : la grille ne saute pas.
 */
export function coverUrl(book: Pick<BookSummary, "id" | "coverTag" | "fileTag">): string | null {
  if (book.coverTag) return `/api/jellyfin/image?itemId=${book.id}&tag=${encodeURIComponent(book.coverTag)}&kind=poster`;
  if (book.fileTag) return `/api/books/${book.id}/cover?v=${encodeURIComponent(book.fileTag)}`;
  return null;
}

/** Une teinte stable par titre : le même livre a toujours la même couverture dessinée. */
export function coverHue(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function DrawnCover({ book }: { book: Pick<BookSummary, "name" | "seriesName" | "index" | "authors"> }) {
  const title = displayTitle(book);
  const hue = coverHue(book.name);
  return (
    <div
      className="absolute inset-0 flex flex-col justify-between p-[9%] text-left"
      style={{ background: `linear-gradient(160deg, hsl(${hue} 32% 30%), hsl(${(hue + 24) % 360} 38% 16%))` }}
      aria-hidden
    >
      <span className="block h-px w-1/3 bg-white/45" />
      <span className="line-clamp-5 font-display text-[clamp(0.8rem,7cqw+0.2rem,1.35rem)] font-semibold leading-tight text-white [overflow-wrap:anywhere]">{title}</span>
      <span className="line-clamp-2 text-[clamp(0.6rem,4.5cqw,0.85rem)] font-medium uppercase tracking-wide text-white/70">{book.authors[0] ?? ""}</span>
    </div>
  );
}

/**
 * Les couvertures que le serveur n'a pas (204) ou n'a pas pu donner, pour la page : une grille remontée ou
 * revue ne les redemande pas. Des réponses en échec en rafale ont déjà fait bannir un compte par le pare-feu
 * devant le proxy (29/10/2026) — moins on en envoie, mieux c'est.
 */
const missingCovers = new Set<string>();

export function BookCover({ book, className = "", eager = false }: { book: BookSummary; className?: string; eager?: boolean }) {
  const proposed = coverUrl(book);
  const url = proposed && !missingCovers.has(proposed) ? proposed : null;
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`relative aspect-[2/3] overflow-hidden bg-surface [container-type:inline-size] ${className}`}>
      {/* Dessinée dessous : visible tant que l'image n'est pas là, ou si elle n'existe pas. */}
      {(!url || failed || !loaded) && <DrawnCover book={book} />}
      {url && !failed && (
        // eslint-disable-next-line @next/next/no-img-element -- relais d'images déjà dimensionné (Jellyfin ou le serveur) ; l'optimiseur le recompresserait pour rien.
        <img
          src={url}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => {
            missingCovers.add(url);
            setFailed(true);
          }}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {/* Le relief d'un dos de livre : une ombre fine à gauche, un reflet à peine visible. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-black/30 to-transparent" aria-hidden />
    </div>
  );
}

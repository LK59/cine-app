/**
 * Ce que les routes des livres envoient à l'écran (DECISIONS.md §127). À part du catalogue des films
 * et des séries, exprès : rien de ce qui est gardé sur l'appareil (`persistentCache.ts`) n'en dépend,
 * et l'option coupée n'y laisse aucune trace.
 */

/** Où en est ce compte dans un livre — gardé par l'application, pas par Jellyfin. */
export interface BookProgress {
  /** La position exacte (EPUB CFI), celle que le lecteur rouvre. */
  cfi: string;
  /** De 0 à 1, sur tout le livre. */
  fraction: number;
  updatedAt: number;
  /** Arrivé au bout au moins une fois (et noté « lu » chez Jellyfin). */
  finished: boolean;
}

export interface BookSummary {
  id: string;
  name: string;
  /** L'empreinte de la couverture chez Jellyfin (`ImageTags.Primary`) — `null` : pas de couverture. */
  coverTag: string | null;
  seriesName: string | null;
  /** Le tome dans la série ; `null` quand Jellyfin n'en connaît pas. */
  index: number | null;
  year: number | null;
  authors: string[];
  /** Lu selon Jellyfin, pour ce compte. */
  played: boolean;
  progress: BookProgress | null;
}

export interface BookDetail extends BookSummary {
  overview: string;
  genres: string[];
}

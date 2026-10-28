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
  /** Retiré de « Continuer la lecture » depuis la dernière page lue (la position reste). */
  dismissed?: boolean;
}

export interface BookSummary {
  id: string;
  name: string;
  /** L'empreinte de la couverture chez Jellyfin (`ImageTags.Primary`) — `null` : pas de couverture. */
  coverTag: string | null;
  /**
   * L'empreinte du fichier chez Jellyfin (`Etag`) : la couverture tirée de l'EPUB quand Jellyfin n'en a
   * pas (`/api/books/<id>/cover?v=…`) se garde tant que le fichier ne change pas.
   */
  fileTag: string | null;
  seriesName: string | null;
  /** Le tome dans la série ; `null` quand Jellyfin n'en connaît pas. */
  index: number | null;
  year: number | null;
  authors: string[];
  /** Les genres regroupés (Jellyfin et sujets de l'EPUB, `bookGenres`) ; vide quand on n'en sait rien. */
  genres: string[];
  /** Ajouté à la bibliothèque (ms), pour « Derniers ajouts » ; `null` : inconnu. */
  addedAt: number | null;
  /** Lu selon Jellyfin, pour ce compte. */
  played: boolean;
  progress: BookProgress | null;
}

export interface BookDetail extends BookSummary {
  overview: string;
}

// Ce que le lecteur (`BookReader.tsx`) utilise de foliate-js, et rien d'autre : le module est du
// JavaScript copié tel quel (README.md à côté), sans types à lui.

export interface FoliateTocItem {
  label?: string;
  href?: string;
  subitems?: FoliateTocItem[] | null;
}

export interface FoliateSection {
  linear?: string;
  resolveHref?: (href: string) => string;
}

/** La cible des événements `load` (ressource à charger) et `data` (contenu à transformer) du chargeur. */
export interface FoliateLoadDetail {
  type: string;
  isScript: boolean;
  allow: boolean | Promise<boolean>;
}
export interface FoliateDataDetail {
  readonly name: string;
  type: string;
  data: unknown;
}

export interface FoliateBook {
  metadata?: { title?: unknown; language?: string | string[] };
  toc?: FoliateTocItem[];
  sections: FoliateSection[];
  rendition?: { layout?: string };
  dir?: string;
  transformTarget?: EventTarget;
  isExternal?: (href: string) => boolean;
  destroy?: () => void;
}

export interface FoliateRelocateDetail {
  fraction?: number;
  cfi?: string;
  tocItem?: FoliateTocItem | null;
  location?: { current: number; next: number; total: number };
  section?: { current: number; total: number };
  /** Minutes restantes estimées (foliate-js compte 1 600 caractères de source par minute). */
  time?: { section: number; total: number };
  /** Le texte de la page montrée, dans le document du chapitre. */
  range?: Range | null;
}

/** Un résultat de `search` : l'avancement, ou les trouvailles d'un chapitre avec leur contexte. */
export type FoliateSearchResult =
  | "done"
  | { progress: number }
  | { label: string; subitems: { cfi: string; excerpt: { pre: string; match: string; post: string } }[] };

export interface FoliateRenderer extends HTMLElement {
  setStyles?: (styles: string | [string, string]) => void;
  getContents: () => { doc: Document; index: number }[];
  atStart?: boolean;
  atEnd?: boolean;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  destroy?: () => void;
}

export interface FoliateView extends HTMLElement {
  book: FoliateBook;
  renderer: FoliateRenderer;
  isFixedLayout: boolean;
  open: (book: FoliateBook) => Promise<void>;
  close: () => void;
  init: (options: { lastLocation?: string | null; showTextStart?: boolean }) => Promise<void>;
  goTo: (target: string | number) => Promise<unknown>;
  goToFraction: (fraction: number) => Promise<void>;
  getSectionFractions: () => number[];
  resolveNavigation: (target: string | number) => { index: number } | undefined;
  lastLocation?: FoliateRelocateDetail | null;
  goLeft: () => Promise<void>;
  goRight: () => Promise<void>;
  next: (distance?: number) => Promise<void>;
  prev: (distance?: number) => Promise<void>;
  /** Cherche dans tout le texte du livre, chapitre par chapitre ; chaque trouvaille est soulignée sur la page. */
  search: (options: { query: string; index?: number; drawOptions?: { color?: string } }) => AsyncGenerator<FoliateSearchResult, void, undefined>;
  clearSearch: () => void;
}

export function makeBook(file: File | Blob | string): Promise<FoliateBook>;
export class ResponseError extends Error {}
export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}

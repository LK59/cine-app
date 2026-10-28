"use client";

import { useEffect, useSyncExternalStore } from "react";
import { lazyNow } from "./lazyNow";
import useSWR, { preload } from "swr";
import { LayoutGrid } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";
import { cinemaNavigate, useCinemaRoute } from "@/lib/cinemaRoute";

/**
 * Ce que l'accueil du cinéma sait des livres (option, DECISIONS.md §127) — et rien de plus : ce module
 * est le seul que les deux écrans du cinéma importent. Il lit l'option dans la configuration publique
 * (la même clé que le reste de l'accueil, aucune requête de plus) et ne charge l'accueil des livres
 * (`BooksHome`, morceau à part) que dans la catégorie Livres.
 *
 * Son propre type pour la réponse, comme `useOfflineDownloadsEnabled` : celui de `usePlayerEnabled`
 * fait partie de ce que le cache de l'appareil garde, et un champ de plus l'aurait vidé partout.
 */

export interface BooksMode {
  /** La catégorie Livres est affichée (option allumée et `#livres=1`). */
  active: boolean;
  /** Ce que la bascule reçoit ; `undefined` option coupée — elle garde alors ses deux boutons. */
  toggle: { active: boolean; onSelect: () => void; onLeave: (mode: "movies" | "series") => void; onIntent: () => void } | undefined;
}

// Entrer : le code de l'accueil des livres d'abord (déjà là d'ordinaire, demandé à l'intention), pour
// qu'il paraisse au rendu même qui suit — sans les 300 ms qu'une suspension coûtait (`lazyNow`).
const enter = () => {
  void BooksHomeLazy.preload()
    .catch(() => {})
    .finally(() => cinemaNavigate({ books: true, film: null, serie: null }, "replace"));
};
const leave = (tab: "movies" | "series") => cinemaNavigate({ books: false, booksAll: null, tab, film: null, serie: null }, "replace");

/**
 * L'intention d'ouvrir les livres — le survol, le doigt posé, le focus du bouton Livres : leur accueil
 * (son code et ses rangées) se prépare avant le clic. Mesuré le 28/10/2026 : ~270 ms entre le clic et
 * les premières couvertures sur iPhone, cache chaud, faute de l'avoir fait. Rien avant ce geste : la
 * catégorie fermée, rien des livres n'est chargé.
 */
let intended = false;
const intent = () => {
  if (intended) return;
  intended = true;
  void BooksHomeLazy.preload().catch(() => {
    intended = false;
  });
  void preload("/api/books/home", fetcher).catch(() => {});
};

export function useBooksMode(inAddress: boolean | undefined): BooksMode {
  const { data } = useSWR<{ booksEnabled?: boolean }>("/api/config/public", fetcher, playerBootstrapOptions);
  const enabled = data?.booksEnabled === true;
  const known = data !== undefined;
  // Une adresse `#livres=1` sur une installation où l'option est coupée (lien gardé, option retirée
  // depuis) : le mode est retiré de l'adresse, et l'accueil reste celui des films et séries.
  const bookInAddress = !!useCinemaRoute().book;
  useEffect(() => {
    if (known && !enabled && (inAddress || bookInAddress)) cinemaNavigate({ books: false, book: null, reading: false, booksAll: null }, "replace");
  }, [known, enabled, inAddress, bookInAddress]);
  if (!enabled) return { active: false, toggle: undefined };
  const active = inAddress === true;
  return { active, toggle: { active, onSelect: enter, onLeave: leave, onIntent: intent } };
}

const BooksSearchLazy = lazyNow(() => import("./BooksSearch").then((m) => m.BooksSearch));

/**
 * La section « Livres » de la recherche de l'application : rien, et aucun code des livres chargé, tant
 * que l'option est coupée — la recherche reste alors exactement ce qu'elle était.
 */
export function BooksSearchEntry({ query }: { query: string }) {
  const { data } = useSWR<{ booksEnabled?: boolean }>("/api/config/public", fetcher, playerBootstrapOptions);
  if (data?.booksEnabled !== true) return null;
  return <BooksSearchLazy query={query} />;
}

const BooksDownloadsLazy = lazyNow(() => import("./BooksDownloads").then((m) => m.BooksDownloads));

// Ce que la page des téléchargements sait des livres sans rien charger d'eux : combien l'appareil en
// garde (`offlineBooks.ts` l'écrit), et si les livres étaient affichés pour ce compte au dernier passage
// en ligne — sans réseau, la configuration ne répond pas.
const COUNT_KEY = "laterna:books:offline-count";
const SHOWN_KEY = "laterna:books:shown";
const readKey = (key: string) => () => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const subscribeStorage = (listener: () => void) => {
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
};

/** L'appareil garde-t-il des livres que ce compte peut voir ? Faux tant que rien ne le dit. */
export function useOfflineBooksPresent(): boolean {
  const { data, error } = useSWR<{ booksEnabled?: boolean }>("/api/config/public", fetcher, playerBootstrapOptions);
  const count = Number(useSyncExternalStore(subscribeStorage, readKey(COUNT_KEY), () => null) ?? 0);
  const shownBefore = useSyncExternalStore(subscribeStorage, readKey(SHOWN_KEY), () => null);
  const known = typeof data?.booksEnabled === "boolean";
  useEffect(() => {
    if (!known) return;
    try {
      localStorage.setItem(SHOWN_KEY, data?.booksEnabled ? "1" : "0");
    } catch {
      /* sans mémoire : hors ligne, la section suivra le dernier état connu */
    }
  }, [known, data?.booksEnabled]);
  if (count <= 0) return false;
  if (known) return data?.booksEnabled === true;
  // Hors ligne (ou la configuration en panne) : le dernier état connu.
  return (error !== undefined || data === undefined) && shownBefore === "1";
}

/**
 * La section « Livres » de la page des téléchargements : rien, et aucun code des livres chargé, tant
 * que l'appareil n'en garde pas ou que les livres ne sont pas affichés pour ce compte.
 */
export function BooksDownloadsEntry({ present }: { present: boolean }) {
  return present ? <BooksDownloadsLazy /> : null;
}

/** L'accueil des livres, chargé seulement dans la catégorie Livres (ou à l'intention de l'ouvrir). */
export const BooksHomeLazy = lazyNow(() => import("./BooksHome").then((m) => m.BooksHome));

/**
 * « Tous les livres », le rond de « Tous les films / séries » dans la catégorie Livres : il mène à la
 * grille complète (`/livres`). Un lien ordinaire, pas une navigation de Next : la page des livres a sa
 * propre politique de sécurité (celle qui permet les cadres du lecteur), qu'un changement de page
 * côté client ne poserait pas.
 */
export function BooksBrowseAllButton() {
  const t = useT();
  const label = t("books.browseAll");
  return (
    // La grille par-dessus l'accueil, sans changer de page (`#tous=1`) : elle n'a pas besoin de la
    // politique de sécurité du lecteur, seule raison de la page `/livres`.
    <button
      type="button"
      onClick={() => cinemaNavigate({ booksAll: "1", book: null, reading: false })}
      aria-label={label}
      title={label}
      data-liquid
      className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white"
    >
      <LayoutGrid size={17} aria-hidden />
    </button>
  );
}

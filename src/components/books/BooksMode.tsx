"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
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
  toggle: { active: boolean; onSelect: () => void; onLeave: (mode: "movies" | "series") => void } | undefined;
}

const enter = () => cinemaNavigate({ books: true, film: null, serie: null }, "replace");
const leave = (tab: "movies" | "series") => cinemaNavigate({ books: false, tab, film: null, serie: null }, "replace");

export function useBooksMode(inAddress: boolean | undefined): BooksMode {
  const { data } = useSWR<{ booksEnabled?: boolean }>("/api/config/public", fetcher, playerBootstrapOptions);
  const enabled = data?.booksEnabled === true;
  const known = data !== undefined;
  // Une adresse `#livres=1` sur une installation où l'option est coupée (lien gardé, option retirée
  // depuis) : le mode est retiré de l'adresse, et l'accueil reste celui des films et séries.
  const bookInAddress = !!useCinemaRoute().book;
  useEffect(() => {
    if (known && !enabled && (inAddress || bookInAddress)) cinemaNavigate({ books: false, book: null, reading: false }, "replace");
  }, [known, enabled, inAddress, bookInAddress]);
  if (!enabled) return { active: false, toggle: undefined };
  const active = inAddress === true;
  return { active, toggle: { active, onSelect: enter, onLeave: leave } };
}

const BooksSearchLazy = dynamic(() => import("./BooksSearch").then((m) => m.BooksSearch), { ssr: false });

/**
 * La section « Livres » de la recherche de l'application : rien, et aucun code des livres chargé, tant
 * que l'option est coupée — la recherche reste alors exactement ce qu'elle était.
 */
export function BooksSearchEntry({ query }: { query: string }) {
  const { data } = useSWR<{ booksEnabled?: boolean }>("/api/config/public", fetcher, playerBootstrapOptions);
  if (data?.booksEnabled !== true) return null;
  return <BooksSearchLazy query={query} />;
}

/** L'accueil des livres, chargé seulement dans la catégorie Livres. */
export const BooksHomeLazy = dynamic(() => import("./BooksHome").then((m) => m.BooksHome), { ssr: false });

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
    <a href="/livres" aria-label={label} title={label} data-liquid className="nav-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white">
      <LayoutGrid size={17} aria-hidden />
    </a>
  );
}

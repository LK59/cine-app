"use client";

import dynamic from "next/dynamic";

/** L'écran des livres, rendu par le navigateur seul : tout y vient de requêtes faites après l'ouverture. */
export const BooksScreenLazy = dynamic(() => import("./BooksScreen").then((m) => m.BooksScreen), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex items-center justify-center bg-ink">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>
  ),
});

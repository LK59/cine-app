"use client";

import { lazyNow } from "./lazyNow";

/**
 * L'écran des livres, rendu par le navigateur seul : tout y vient de requêtes faites après l'ouverture.
 * Sans Suspense (`lazyNow`) : React retenait l'écran 300 ms de plus.
 */
export const BooksScreenLazy = lazyNow(
  () => import("./BooksScreen").then((m) => m.BooksScreen),
  <div className="fixed inset-0 flex items-center justify-center bg-ink">
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
  </div>
);

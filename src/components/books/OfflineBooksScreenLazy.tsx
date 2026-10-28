"use client";

import dynamic from "next/dynamic";

/** Les livres de l'appareil, rendus par le navigateur seul : tout y vient de l'appareil. */
export const OfflineBooksScreenLazy = dynamic(() => import("./OfflineBooksScreen").then((m) => m.OfflineBooksScreen), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex items-center justify-center bg-ink">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>
  ),
});

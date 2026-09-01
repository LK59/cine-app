"use client";

import dynamic from "next/dynamic";
import { createPortal } from "react-dom";

// ssr:false — see CinemaClient's own doc comment for why (unrecoverable hydration mismatch on a
// page that's 100% client-fetched anyway, same pattern as PlayerHostLazy/GlobalSearchLazy).
// Loading fallback is portaled to document.body too — same reason as CinemaClient's own portal:
// PageTransition's fade-in-up animation permanently sets a non-none transform (fill-mode both),
// which makes it the containing block for any `fixed` descendant instead of the viewport.
const CinemaClient = dynamic(() => import("@/components/cinema/CinemaClient").then((m) => m.CinemaClient), {
  ssr: false,
  loading: () =>
    createPortal(
      <div className="fixed inset-0 flex items-center justify-center bg-slate-950" style={{ zIndex: 200 }}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>,
      document.body
    ),
});

export default function CinemaPage() {
  return <CinemaClient />;
}

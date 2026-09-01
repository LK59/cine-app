"use client";

import dynamic from "next/dynamic";

// ssr:false — see CinemaClient's own doc comment for why (unrecoverable hydration mismatch on a
// page that's 100% client-fetched anyway, same pattern as PlayerHostLazy/GlobalSearchLazy).
const CinemaClient = dynamic(() => import("@/components/cinema/CinemaClient").then((m) => m.CinemaClient), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-[45] flex items-center justify-center bg-slate-950">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>
  ),
});

export default function CinemaPage() {
  return <CinemaClient />;
}

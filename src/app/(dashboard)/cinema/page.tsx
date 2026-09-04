"use client";

import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { useIsMobile } from "@/lib/useIsMobile";

// ssr:false — see CinemaClient's own doc comment for why (unrecoverable hydration mismatch on a
// page that's 100% client-fetched anyway, same pattern as PlayerHostLazy/GlobalSearchLazy).
// Loading fallback is portaled to document.body too — same reason as CinemaClient's own portal:
// PageTransition's fade-in-up animation permanently sets a non-none transform (fill-mode both),
// which makes it the containing block for any `fixed` descendant instead of the viewport.
function loadingPortal() {
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center bg-ink" style={{ zIndex: 200 }}>
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>,
    document.body
  );
}

const CinemaClient = dynamic(() => import("@/components/cinema/CinemaClient").then((m) => m.CinemaClient), {
  ssr: false,
  loading: loadingPortal,
});

const CinemaMobileClient = dynamic(
  () => import("@/components/cinema/mobile/CinemaMobileClient").then((m) => m.CinemaMobileClient),
  { ssr: false, loading: loadingPortal }
);

// Two genuinely different screens rather than one responsive layout — see CinemaMobileClient's
// own doc comment. Splitting at the route means a phone never downloads the desktop screen's
// bundle (YouTube IFrame API, TV grid navigation, the split-pane hero) or vice versa.
export default function CinemaPage() {
  const isMobile = useIsMobile();
  return isMobile ? <CinemaMobileClient /> : <CinemaClient />;
}

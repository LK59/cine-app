"use client";

import { useSyncExternalStore } from "react";

// Tailwind's own md breakpoint — the same line the rest of the app's responsive classes switch
// on, so "mobile" here means exactly what it means everywhere else in the UI.
const MOBILE_QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

// useSyncExternalStore rather than the usual useState+useEffect media-query pattern: that one
// needs a setState in the effect body to seed the initial value (which this project's
// react-hooks/set-state-in-effect rule rejects) and renders one frame with a guessed value.
// The server snapshot returns false — desktop is the safe assumption for markup that only exists
// to be hydrated, and the client corrects it on the very first client render.
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  );
}

"use client";

import dynamic from "next/dynamic";

// GlobalSearch renders `null` until opened (Cmd/Ctrl+K) — lazy-loading it keeps
// its ~500 lines of search/fuzzy-matching logic out of the initial bundle sent
// on every dashboard route. `next/dynamic` + `ssr: false` requires a Client
// Component boundary, hence this thin wrapper around the server-rendered layout.
export const GlobalSearchLazy = dynamic(
  () => import("@/components/GlobalSearch").then((m) => m.GlobalSearch),
  { ssr: false }
);

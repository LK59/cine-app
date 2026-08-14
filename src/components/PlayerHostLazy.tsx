"use client";

import dynamic from "next/dynamic";

// PlayerHost renders `null` until something is playing — lazy-loading it keeps hls.js and
// the playback plumbing out of the initial bundle sent on every dashboard route. `next/dynamic`
// + `ssr: false` requires a Client Component boundary, hence this thin wrapper around the
// server-rendered layout (same pattern as GlobalSearchLazy).
export const PlayerHostLazy = dynamic(
  () => import("@/components/PlayerHost").then((m) => m.PlayerHost),
  { ssr: false }
);

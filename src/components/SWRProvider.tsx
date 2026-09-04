"use client";

import { SWRConfig } from "swr";
import { isWatchingFullScreen } from "@/lib/playbackBusy";

export function SWRProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        // Nothing is polled while a film has the whole screen: the page behind it is mounted and
        // invisible, and its polls would be radio wake-ups and re-renders nobody can see —
        // competing for bandwidth with the byte ranges the film itself is reading. Everything
        // catches up when the player closes, since stale data is revalidated on mount anyway.
        isPaused: isWatchingFullScreen,
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        revalidateIfStale: true,
        dedupingInterval: 10000,
        keepPreviousData: true,
      }}
    >
      {children}
    </SWRConfig>
  );
}

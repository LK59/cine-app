"use client";

import { useEffect } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { isWatchingFullScreen } from "@/lib/playbackBusy";
import { hydrateFromDisk, persistMiddleware, requestPersistence } from "@/lib/persistentCache";

/**
 * Relit, au démarrage, le catalogue gardé sur l'appareil pour ce compte — voir `persistentCache.ts`.
 *
 * Posé dans SWR par `mutate`, sans requête : c'est le montage du cinéma qui la fera, puisqu'une
 * donnée présente est tenue pour périmée (`revalidateIfStale`). Le cinéma attend cette lecture
 * (`catalogueCacheReady`, 150 ms au plus) avant de s'afficher ; les écrans rendus par le serveur,
 * eux, ne l'attendent pas — la donnée arrive après leur premier rendu, comme n'importe quelle
 * réponse, et le rendu du serveur reste celui que le navigateur hydrate.
 */
function PersistentCacheHydrator({ account }: { account: string | null }) {
  const { cache, mutate } = useSWRConfig();
  useEffect(() => {
    void hydrateFromDisk(account, {
      has: (key) => cache.get(key) !== undefined,
      set: (key, data) => void mutate(key, data, { revalidate: false }),
    });
    if (account && typeof navigator !== "undefined") void requestPersistence(navigator.userAgent, navigator.storage);
  }, [account, cache, mutate]);
  return null;
}

export function SWRProvider({ children, account = null }: { children: React.ReactNode; account?: string | null }) {
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
        // Toute réponse d'un flux de l'écran d'accueil est gardée pour la prochaine ouverture.
        use: [persistMiddleware],
      }}
    >
      <PersistentCacheHydrator account={account} />
      {children}
    </SWRConfig>
  );
}

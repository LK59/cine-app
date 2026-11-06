"use client";

import { useEffect } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { SWRGlobalState, revalidateEvents, type Cache, type RevalidateEvent } from "swr/_internal";
import { foregroundHeld, onForegroundRelease } from "@/lib/foregroundGate";
import { isWatchingFullScreen } from "@/lib/playbackBusy";
import { hydrateFromDisk, persistMiddleware, startPersistence, swrEntryHolds } from "@/lib/persistentCache";

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
      // Pas `cache.get(key) !== undefined` : SWR inscrit chaque clé au montage de ses crochets, même
      // de ceux qui ne demandent rien, et « Reprendre » n'était jamais posé — voir `swrEntryHolds`.
      has: (key) => swrEntryHolds(cache.get(key)),
      set: (key, data) => void mutate(key, data, { revalidate: false }),
    });
    if (account && typeof navigator !== "undefined") startPersistence(navigator.userAgent, navigator.storage);
  }, [account, cache, mutate]);
  return null;
}

/**
 * Visible pour SWR : la page l'est, et aucun retour au premier plan n'attend sa réponse de version
 * (`foregroundGate.ts`, DECISIONS.md §134).
 *
 * SWR n'offre pas de crochet pour retarder sa relecture au focus : `initFocus` n'est lu que pour un
 * `provider` neuf, et un `provider` neuf serait un second cache, que le `mutate` global de `swr.ts` ne
 * verrait plus. Il demande en revanche `isVisible()` avant chaque relecture au focus, à la reconnexion
 * et à chaque tour de sondage : retenu, il saute ces relectures — puis `ForegroundReplay` les rejoue à
 * l'ouverture de la porte. Un tour de sondage sauté n'est pas rejoué : le suivant partira à son heure.
 */
function visibleAndReleased(): boolean {
  const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
  return visible && !foregroundHeld();
}

/**
 * Rejoue, à l'ouverture de la porte, ce que SWR a sauté pendant qu'elle était fermée : la relecture au
 * focus de chaque clé montée (la même boucle que SWR, `revalidators[0]` de chaque clé), et la
 * reconnexion si le réseau est revenu entre-temps. Une page qui se recharge n'arrive jamais ici.
 */
function ForegroundReplay() {
  const { cache } = useSWRConfig();
  useEffect(() => {
    let reconnected = false;
    const onOnline = () => {
      if (foregroundHeld()) reconnected = true;
    };
    const replay = (type: RevalidateEvent) => {
      const state = SWRGlobalState.get(cache as Cache);
      if (!state) return;
      const revalidators = state[0];
      for (const key in revalidators) revalidators[key][0]?.(type);
    };
    const stop = onForegroundRelease(() => {
      replay(revalidateEvents.FOCUS_EVENT);
      if (reconnected) replay(revalidateEvents.RECONNECT_EVENT);
      reconnected = false;
    });
    window.addEventListener("online", onOnline);
    return () => {
      stop();
      window.removeEventListener("online", onOnline);
    };
  }, [cache]);
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
        isVisible: visibleAndReleased,
        // Toute réponse d'un flux de l'écran d'accueil est gardée pour la prochaine ouverture.
        use: [persistMiddleware],
      }}
    >
      <PersistentCacheHydrator account={account} />
      <ForegroundReplay />
      {children}
    </SWRConfig>
  );
}

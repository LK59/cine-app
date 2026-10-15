"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSWRConfig } from "swr";
import { readCatalogueBody } from "@/lib/cinemaPayload";
import { catalogueRefreshDue, refreshCatalogues, REFRESHED_CATALOGUE_KEYS } from "@/lib/catalogueRefresh";
import { isWatchingFullScreen } from "@/lib/playbackBusy";
import { renewPersisted } from "@/lib/persistentCache";
import { whenUiQuiet } from "@/lib/uiQuiet";

/**
 * Les deux catalogues relus au retour au premier plan, passé un quart d'heure — pour les deux
 * accueils (15/10/2026, DECISIONS.md §96). La décision et la requête vivent dans
 * `catalogueRefresh.ts` ; ce crochet ne dit que *quand*.
 *
 * - **Au retour** : `visibilitychange` vers « visible », et le focus de la fenêtre (un ordinateur
 *   qui revient d'une autre application sans que l'onglet ait été caché).
 * - **Jamais pendant un film**, ni sous la grille complète ouverte (`blocked`) : SWR est en pause en
 *   plein écran et la donnée posée redessinerait une page qu'on ne regarde pas ; la grille, elle,
 *   se décalerait sous le doigt. À la levée de `blocked` — le lecteur fermé, la grille refermée —,
 *   la règle est relue : l'échéance passée pendant le film est rattrapée là, une fois. Aucune
 *   requête n'est confiée à SWR pendant sa pause : elle serait jetée, pas différée (CLAUDE.md).
 * - **Jamais page cachée** ; **une seule relecture en vol** (`refreshCatalogues`) ; seulement les
 *   catalogues que l'écran tient déjà — celui des séries, différé, n'est pas demandé pour autant.
 */
export function useCatalogueRefresh(blocked: boolean): void {
  const { cache, mutate } = useSWRConfig();
  const blockedRef = useRef(blocked);

  const canApply = useCallback(
    () => typeof document !== "undefined" && document.visibilityState !== "hidden" && !blockedRef.current && !isWatchingFullScreen(),
    []
  );

  const run = useCallback(() => {
    if (!canApply()) return;
    const keys = REFRESHED_CATALOGUE_KEYS.filter((key) => {
      const entry = cache.get(key) as { data?: unknown; isValidating?: boolean } | undefined;
      // Tenu par l'écran, dû, et sans lecture de SWR en cours — elle ferait la même chose.
      return entry?.data !== undefined && entry.isValidating !== true && catalogueRefreshDue(key);
    });
    if (keys.length === 0) return;
    void refreshCatalogues({
      keys,
      heldNow: (key) => (cache.get(key) as { data?: unknown } | undefined)?.data,
      apply: (key, data) => void mutate(key, data, { revalidate: false }),
      canApply,
      whenQuiet: () => whenUiQuiet(),
      unchanged: (key, data) => renewPersisted(key, data),
      read: (key, res) => readCatalogueBody(key, res),
    });
  }, [cache, mutate, canApply]);

  // La levée de `blocked` relit la règle : c'est la reprise après un film ou la grille.
  useEffect(() => {
    blockedRef.current = blocked;
    if (!blocked) run();
  }, [blocked, run]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", run);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", run);
    };
  }, [run]);
}

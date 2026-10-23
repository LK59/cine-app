"use client";

import useSWR from "swr";
import { fetcher, playerBootstrapOptions } from "@/lib/swr";

/**
 * Le téléchargement hors ligne (bêta) est-il ouvert sur cette installation ? Non tant qu'on ne sait
 * pas. La même configuration publique que `usePlayerEnabled`, lue sous la même clé (une seule
 * requête), mais par son propre type : celui de `usePlayerEnabled` fait partie de ce que le cache de
 * l'appareil garde (`persistentCache-schema.test.ts`), et un champ de plus l'aurait vidé partout.
 */
export function useOfflineDownloadsEnabled(
  /**
   * Faux : ne rien demander et répondre « non » — pour un écran qui n'a pas de hors ligne du tout (la
   * fiche d'un lien de partage, qui ne demande que les routes de la porte des liens).
   */
  active = true
): boolean {
  const { data } = useSWR<{ playerEnabled?: boolean; offlineDownloads?: boolean }>(active ? "/api/config/public" : null, fetcher, playerBootstrapOptions);
  return data?.offlineDownloads === true && data.playerEnabled === true;
}

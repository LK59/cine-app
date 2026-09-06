"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { ConfiguredServices, ServiceKey } from "@/lib/services";

interface PublicConfig {
  defaultLang: string;
  playerEnabled: boolean;
  configured: ConfiguredServices;
}

/**
 * Ce qui est branché sur cette installation.
 *
 * Chargé une fois pour toute la session : c'est une variable d'environnement, elle ne change pas
 * sans redémarrage. Tant que la réponse n'est pas là, on répond « oui » — mieux vaut une page qui
 * s'affiche puis se corrige qu'un écran « non configuré » qui clignote sur une installation où
 * tout va bien.
 */
export function useConfiguredServices(): { isConfigured: (service: ServiceKey) => boolean; ready: boolean } {
  const { data } = useSWR<PublicConfig>("/api/config/public", fetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    dedupingInterval: 60 * 60 * 1000,
  });
  return {
    isConfigured: (service) => data?.configured?.[service] ?? true,
    ready: !!data,
  };
}

"use client";

import { useEffect, useState } from "react";
import type { UnifiedSearchResult } from "@/app/api/search/route";

export interface DescribeResponse {
  available: boolean;
  results: UnifiedSearchResult[];
}

/** Le temps d'arrêt avant de demander : la frappe s'est posée, ce n'est pas un mot en cours. */
const DESCRIBE_DELAY_MS = 600;

/**
 * Une recherche par description, sur le modèle des répliques (`useDialogueSearch`) : partie après
 * un temps d'arrêt, **annulée** dès que la frappe change, jamais avant les titres. `url` nulle :
 * rien à chercher. Un échec ne se dit pas — la recherche ordinaire est là, et une description qui
 * n'a rien donné n'a rien à montrer.
 */
export function useDescribeSearch(url: string | null): { results: UnifiedSearchResult[] | undefined; loading: boolean } {
  const [state, setState] = useState<{ url: string; results: UnifiedSearchResult[] } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(url, { signal: controller.signal })
        .then((res) => (res.ok ? (res.json() as Promise<DescribeResponse>) : Promise.reject(new Error(String(res.status)))))
        .then((data) => setState({ url, results: data.results ?? [] }))
        .catch(() => {
          if (!controller.signal.aborted) setState({ url, results: [] });
        });
    }, DESCRIBE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);
  const current = url !== null && state?.url === url ? state : null;
  return { results: current?.results, loading: url !== null && current === null };
}

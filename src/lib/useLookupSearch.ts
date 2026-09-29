"use client";

import { useCallback, useRef, useState } from "react";
import { fetcher } from "@/lib/swr";

/**
 * La recherche de la fenêtre « Ajouter » des pages Radarr et Sonarr — un titre tapé, soumis,
 * cherché chez le service.
 *
 * Les deux fenêtres faisaient `setResults(await res.json())` sans lire `res.ok` et sans `catch` :
 * sur un 4xx/5xx, la fenêtre restait vide et muette, exactement comme une recherche qui n'avait
 * rien trouvé — qui, elle non plus, ne disait rien ; une erreur réseau devenait un rejet non géré.
 * Elles partagent donc ce crochet, et la règle : trois issues distinctes, dites chacune
 * (`found`, `empty`, `failed`), et jamais « rien trouvé » pour une recherche qui a échoué.
 *
 * Pas de SWR ici : c'est une question posée à la soumission, pas une clé qu'on suit, et le
 * `keepPreviousData` global de `SWRProvider` y rendrait les résultats d'une autre frappe. La
 * lecture passe tout de même par `fetcher`, qui lit `res.ok`, signale une session disparue et
 * rapporte le message du serveur.
 */
export type LookupState<T> =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "found"; results: T[] }
  | { status: "empty"; term: string }
  // `message` : ce que le serveur a expliqué, ou `null` quand il n'a rien pu dire (réseau coupé,
  // réponse illisible) — l'écran met alors sa propre phrase.
  | { status: "failed"; message: string | null };

export function useLookupSearch<T>(endpoint: string): {
  state: LookupState<T>;
  searching: boolean;
  results: T[];
  search: (term: string) => Promise<void>;
  retry: () => void;
} {
  const [state, setState] = useState<LookupState<T>>({ status: "idle" });
  // Seule la dernière question répond : une réponse lente d'une frappe précédente ne recouvre
  // pas celle qu'on attend.
  const seq = useRef(0);
  const lastTerm = useRef("");

  const search = useCallback(
    async (raw: string) => {
      const term = raw.trim();
      if (!term) return;
      lastTerm.current = term;
      const mine = ++seq.current;
      setState({ status: "searching" });
      let next: LookupState<T>;
      try {
        const body: unknown = await fetcher(`${endpoint}?term=${encodeURIComponent(term)}`);
        if (!Array.isArray(body)) next = { status: "failed", message: null };
        else if (body.length === 0) next = { status: "empty", term };
        else next = { status: "found", results: body as T[] };
      } catch (error) {
        // `fetch` lève un `TypeError` sans phrase utile (« Failed to fetch ») quand le réseau
        // manque ; seul le message de `fetcher` vient du serveur.
        const message = error instanceof Error && !(error instanceof TypeError) && error.message ? error.message : null;
        next = { status: "failed", message };
      }
      if (mine === seq.current) setState(next);
    },
    [endpoint],
  );

  const retry = useCallback(() => {
    void search(lastTerm.current);
  }, [search]);

  return {
    state,
    searching: state.status === "searching",
    results: state.status === "found" ? state.results : [],
    search,
    retry,
  };
}

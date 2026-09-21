"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { SearchResponse } from "@/app/api/search/route";

/**
 * Une recherche qui répond à ce qu'on tape — et seulement à ça.
 *
 * `keepPreviousData` garde les résultats de la frappe précédente pendant que la suivante part :
 * c'est ce qui rend la frappe vivante, la grille ne clignote pas à chaque lettre. Mais SWR les
 * garde aussi quand la requête suivante *échoue* — hors ligne dans le métro, le serveur qui
 * redémarre : on lisait alors, sous « Dune », les résultats de « Du », sans rien qui dise que la
 * recherche n'avait pas abouti. Et quand il n'y avait rien d'avant, l'échec s'affichait « Rien
 * trouvé », ce qui est faux : on n'en sait rien.
 *
 * Les deux écrans de recherche du lecteur — la recherche générale et l'ajout dans « Ma liste » —
 * posaient chacun le même `useSWR` avec la même option ; ils partagent donc ce crochet, et la
 * règle : une erreur pour *cette* clé efface ce qu'on montre, et se dit (`failed`).
 */
export function useSearchResults(url: string | null): {
  data: SearchResponse | undefined;
  isLoading: boolean;
  failed: boolean;
} {
  const { data, error, isLoading } = useSWR<SearchResponse>(url, fetcher, {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });
  // L'erreur de SWR est celle de la clé courante, jamais d'une précédente : si elle est là, les
  // données qu'on tient sont forcément celles d'une autre frappe.
  const failed = url !== null && error !== undefined;
  return { data: failed ? undefined : data, isLoading, failed };
}

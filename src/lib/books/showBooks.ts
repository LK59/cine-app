"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { fetcher, followOnlyOptions, playerBootstrapOptions } from "@/lib/swr";

/**
 * « Afficher les livres » (DECISIONS.md §127) : le choix d'un compte, gardé par le serveur
 * (`user_preferences.show_books`) et donc le même sur tous ses appareils, comme la disposition de
 * l'accueil (§52). Coupé, le serveur répond `booksEnabled: false` dans la configuration publique — la
 * clé que lisent la bascule, la recherche et les demandes : tout se passe comme l'option coupée, et
 * aucun code des livres n'est chargé.
 *
 * Le réglage n'est montré que l'option de l'installation allumée (`booksAvailable`).
 */
const PREFS = "/api/user/preferences";
const PUBLIC = "/api/config/public";

export function useShowBooksSetting(): { available: boolean; on: boolean } {
  const { data: pub } = useSWR<{ booksAvailable?: boolean }>(PUBLIC, fetcher, playerBootstrapOptions);
  const { data: prefs } = useSWR<{ showBooks?: boolean }>(PREFS, fetcher, followOnlyOptions);
  return { available: pub?.booksAvailable === true, on: prefs?.showBooks !== false };
}

/** Change le choix du compte ; la bascule et la recherche suivent dès que la configuration est relue. */
export async function setShowBooks(on: boolean): Promise<void> {
  await globalMutate(
    PREFS,
    async (current?: Record<string, unknown>) => {
      const res = await fetch(PREFS, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ showBooks: on }) });
      if (!res.ok) throw new Error(String(res.status));
      return { ...(current ?? {}), showBooks: on };
    },
    { optimisticData: (current?: Record<string, unknown>) => ({ ...(current ?? {}), showBooks: on }), rollbackOnError: true, revalidate: false }
  );
  await globalMutate(PUBLIC);
}

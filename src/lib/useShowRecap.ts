"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { fetcher, followOnlyOptions, playerBootstrapOptions } from "@/lib/swr";
import { RECAPS_KEY } from "@/lib/useSeriesRecap";

/**
 * « Précédemment » (DECISIONS.md §137) : le choix d'un compte, gardé par le serveur
 * (`user_preferences.show_recap`), le même sur tous ses appareils — comme « Afficher les livres ».
 * Coupé, rien n'est affiché, et la tâche de fond ne prépare plus rien pour ce compte.
 * Le réglage n'est montré que l'option de l'installation allumée (`recapAvailable`).
 */
const PREFS = "/api/user/preferences";
const PUBLIC = "/api/config/public";

export function useShowRecapSetting(): { available: boolean; on: boolean } {
  const { data: pub } = useSWR<{ recapAvailable?: boolean }>(PUBLIC, fetcher, playerBootstrapOptions);
  const { data: prefs } = useSWR<{ showRecap?: boolean }>(PREFS, fetcher, followOnlyOptions);
  return { available: pub?.recapAvailable === true, on: prefs?.showRecap !== false };
}

export async function setShowRecap(on: boolean): Promise<void> {
  await globalMutate(
    PREFS,
    async (current?: Record<string, unknown>) => {
      const res = await fetch(PREFS, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ showRecap: on }) });
      if (!res.ok) throw new Error(String(res.status));
      return { ...(current ?? {}), showRecap: on };
    },
    { optimisticData: (current?: Record<string, unknown>) => ({ ...(current ?? {}), showRecap: on }), rollbackOnError: true, revalidate: false }
  );
  // Les fiches relisent tout de suite : coupé, le synopsis revient sans attendre dix minutes.
  await globalMutate(RECAPS_KEY);
}

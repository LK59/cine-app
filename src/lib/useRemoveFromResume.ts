"use client";

import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { RESUME_KEY } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";

/**
 * Retirer un film de « Reprendre » — une écriture pour le bureau et le téléphone.
 *
 * La carte part tout de suite (la rangée n'attend pas le serveur), puis Jellyfin oublie la
 * position — la position seule, voir `DELETE /api/jellyfin/resume`. En cas d'échec, la rangée est
 * relue et la carte revient, avec un message : un geste qui échoue en silence laisse croire qu'il
 * a pris (voir `apiAction`, qui lève sur un 4xx).
 */
export function useRemoveFromResume(): (itemId: string) => Promise<void> {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const t = useT();
  return useCallback(
    async (itemId: string) => {
      await mutate(
        RESUME_KEY,
        (current: { items: { id: string }[] } | undefined) =>
          current ? { ...current, items: current.items.filter((item) => item.id !== itemId) } : current,
        { revalidate: false }
      );
      try {
        await apiAction(RESUME_KEY, { method: "DELETE", body: JSON.stringify({ itemId }) });
      } catch {
        toast.error(t("cinema.removeFromContinueFailed"));
      } finally {
        void mutate(RESUME_KEY);
      }
    },
    [mutate, toast, t]
  );
}

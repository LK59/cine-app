"use client";

// Les adresses des signalements dans le cache SWR, et la seule façon de les rafraîchir.
//
// Le cache global retient une réponse dix secondes (`dedupingInterval`) : ouvrir un ticket juste
// après l'avoir envoyé montrait encore le brouillon qu'on venait de quitter, et « Envoyer » une
// seconde fois répondait 409 (24/09/2026). Tout geste qui change un signalement passe donc par
// `useRefreshReports`, qui pose la réponse du serveur à la place de l'ancienne et fait relire les
// listes et les pastilles.

import { useSWRConfig } from "swr";
import type { ReportDetail } from "@/lib/reports";
import { REPORTS_UNREAD_KEY } from "@/lib/useReportBadge";

export const reportKey = (id: number | string) => `/api/reports/${id}`;
export const MY_REPORTS_KEY = "/api/reports";
export const ADMIN_REPORTS_KEY = "/api/admin/activity/reports";

/**
 * Un ticket se relit à chaque ouverture, sans passer par la réponse mémorisée : c'est cette
 * lecture qui le marque lu, et c'est elle qui dit s'il est encore un brouillon.
 */
export const FRESH = { dedupingInterval: 0, revalidateOnMount: true } as const;

export function useRefreshReports(): (detail?: ReportDetail) => Promise<void> {
  const { mutate } = useSWRConfig();
  return async (detail) => {
    if (detail) await mutate(reportKey(detail.id), detail, { revalidate: false });
    await mutate((key) => key === MY_REPORTS_KEY || key === ADMIN_REPORTS_KEY || key === REPORTS_UNREAD_KEY);
  };
}

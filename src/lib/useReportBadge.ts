"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";

export const REPORTS_UNREAD_KEY = "/api/reports/unread";

/**
 * La pastille de l'onglet Compte : une réponse de l'administrateur que la personne n'a pas lue — et,
 * pour l'administrateur, un signalement ou un commentaire qu'il n'a pas lu. Une question par minute,
 * suspendue comme toutes les autres pendant qu'un film occupe l'écran.
 */
export function useReportBadge(): { mine: number; admin: number; any: boolean } {
  const { data } = useSWR<{ mine: number; admin: number }>(REPORTS_UNREAD_KEY, fetcher, { refreshInterval: 60_000 });
  const mine = data?.mine ?? 0;
  const admin = data?.admin ?? 0;
  return { mine, admin, any: mine + admin > 0 };
}

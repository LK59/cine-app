"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { CinemaRecap } from "@/app/api/cinema/recaps/route";

/** La clé de la liste des « Précédemment » du compte (DECISIONS.md §137). */
export const RECAPS_KEY = "/api/cinema/recaps";

/**
 * Le « Précédemment » de cette série pour le compte, ou `null` : la fiche garde alors son résumé.
 *
 * Une seule requête pour toutes les fiches, relue au plus toutes les dix minutes — à l'ouverture
 * d'une fiche comme au retour au premier plan : le texte se prépare pendant l'absence (trois heures
 * sans rien regarder de la série), il doit être lu au retour. Une erreur vaut « rien de prêt ».
 * Les deux fiches de série — bureau et téléphone — passent par ici et par `SeriesRecap`, et nulle part ailleurs.
 */
export function useSeriesRecap(seriesJellyfinId: string | null | undefined): CinemaRecap | null {
  const { data } = useSWR<{ recaps: Record<string, CinemaRecap> }>(seriesJellyfinId ? RECAPS_KEY : null, fetcher, {
    dedupingInterval: 10 * 60 * 1000,
    focusThrottleInterval: 10 * 60 * 1000,
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
  return (seriesJellyfinId && data?.recaps?.[seriesJellyfinId]) || null;
}

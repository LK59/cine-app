"use client";

import { useEffect } from "react";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";

/**
 * Une fiche demandée que le catalogue n'a pas : on le dit, au lieu de ne rien faire (DECISIONS.md §47).
 *
 * L'adresse peut désigner un titre absent du catalogue — un lien ancien, un résultat calculé avant
 * qu'un titre ne sorte du catalogue. La fiche ne se dessinait simplement pas : l'appui « ne faisait
 * rien » (*The Arena*, 05/10/2026). Un message, et l'adresse nettoyée.
 *
 * Seulement sur un catalogue **relu au réseau** (`settled`) : celui gardé sur l'appareil peut dater
 * de quelques jours, et un titre ajouté depuis — ouvert d'une notification — y manquerait à tort.
 */
export function useMissingTitleNotice({
  film,
  serie,
  movies,
  series,
}: {
  film: number | null;
  serie: number | null;
  /** Les fiches du catalogue des films, ou `null` tant qu'il n'est pas relu au réseau. */
  movies: { has: (id: number) => boolean } | null;
  series: { has: (id: number) => boolean } | null;
}): void {
  const toast = useToast();
  const t = useT();
  useEffect(() => {
    const missingFilm = film !== null && movies !== null && !movies.has(film);
    const missingSerie = serie !== null && series !== null && !series.has(serie);
    if (!missingFilm && !missingSerie) return;
    toast.info(t("cinema.titleUnavailable"));
    cinemaNavigate(missingFilm ? { film: null } : { serie: null }, "replace");
    // Les fonctions du message et de traduction ne changent pas ce qu'on vérifie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [film, serie, movies, series]);
}

"use client";

import { useEffect, useRef } from "react";
import { useSWRConfig } from "swr";
import { isWatchingFullScreen } from "@/lib/playbackBusy";
import { NEXT_UP_KEY, RESUME_KEY, TO_WATCH_KEY } from "@/lib/swr";

/**
 * Les listes de la personne — et elles seules — redemandées quand on revient les regarder.
 *
 * Le catalogue est volontairement figé pendant une séance (voir CLAUDE.md, « Only
 * /api/jellyfin/resume and /api/cinema/next-up revalidate on focus »). Ma liste l'était avec lui :
 * un titre ajouté depuis l'ordinateur, l'application ouverte sur l'iPhone, n'y apparaissait ni en
 * changeant d'onglet ni en ouvrant une fiche — seulement en relançant l'application (25/09/2026).
 * Ce sont de petites réponses, qui changent au fil de la journée et parfois ailleurs que dans
 * cine-app (un « vu » marqué sur la télé) : on les redemande au retour de l'application au premier
 * plan et à chaque changement d'onglet Films/Séries. Pas le catalogue.
 *
 * `mutate(clé)` ne relance que les clés qu'un écran affiche : une liste que personne ne regarde
 * n'est pas demandée. Rien pendant un film en plein écran : SWR y est en pause, et une requête
 * mise en pause est perdue, pas reportée — la fermeture du lecteur relit déjà ce qu'elle a changé
 * (`refreshAfterPlayback`).
 */
export const PERSONAL_LIST_KEYS = [TO_WATCH_KEY, "/api/player/lists", RESUME_KEY, NEXT_UP_KEY] as const;

/** Deux retours rapprochés (un aller-retour entre deux applications) ne font qu'une demande. */
const MIN_INTERVAL_MS = 5000;

export function useFreshPersonalLists(tab: string): void {
  const { mutate } = useSWRConfig();
  const lastAt = useRef(0);
  const firstTab = useRef(true);

  useEffect(() => {
    const refresh = () => {
      if (isWatchingFullScreen()) return;
      const now = Date.now();
      if (now - lastAt.current < MIN_INTERVAL_MS) return;
      lastAt.current = now;
      for (const key of PERSONAL_LIST_KEYS) void mutate(key);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    // Un changement d'onglet — pas l'arrivée sur l'écran, où tout vient d'être demandé.
    if (firstTab.current) firstTab.current = false;
    else refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [tab, mutate]);
}

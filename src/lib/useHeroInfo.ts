"use client";

import { useEffect, useState } from "react";
import useSWR, { preload, useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import type { HeroInfo, HeroMediaType } from "@/lib/heroInfo";

/**
 * Le synopsis et la distribution d'un titre de la bannière du bureau — pour les films comme pour
 * les séries, par une seule écriture (les deux bannières avaient chacune la leur).
 *
 * - L'adresse est celle de la requête légère (`/api/cinema/hero/…`), et c'est `heroInfoKey` qui la
 *   construit, pour que le préchargement demande exactement la même chose.
 * - Deux cents millisecondes d'attente avant de demander : un défilement rapide aux flèches ne doit
 *   pas lancer une requête par carte traversée.
 * - Sans la réponse d'avant (`keepPreviousData`, réglé pour toute l'application) : la bannière
 *   recevait sinon le synopsis du titre précédent pendant que celui du nouveau arrivait.
 * - Un titre sans identifiant TMDB n'a rien à demander : il vaut « pas de traduction », et la
 *   bannière montre le synopsis du catalogue.
 */
const DEBOUNCE_MS = 200;
const NO_TRANSLATION: HeroInfo = { tmdb: null };

export function heroInfoKey(type: HeroMediaType, tmdbId: number): string {
  return `/api/cinema/hero/${type}/${tmdbId}`;
}

/** Demande d'avance ce que la bannière affichera — à partir de son adresse (`heroInfoKey`). */
export function preloadHeroInfo(key: string): void {
  void Promise.resolve(preload(key, fetcher)).catch(() => {});
}

export function useHeroInfo(type: HeroMediaType, tmdbId: number | null | undefined): HeroInfo | undefined {
  // Déjà là — préchargé par la rotation, ou vu plus tôt — : aucune raison d'attendre. C'est ce qui
  // fait arriver le synopsis avec le logo pendant la rotation, et non deux cents millisecondes après.
  const { cache } = useSWRConfig();
  const ready = tmdbId ? (cache.get(heroInfoKey(type, tmdbId))?.data as HeroInfo | undefined) : undefined;
  const [settled, setSettled] = useState(tmdbId ?? null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(tmdbId ?? null), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tmdbId]);
  const key = settled ? heroInfoKey(type, settled) : null;
  const { data } = useSWR<HeroInfo>(key, fetcher, { keepPreviousData: false });
  if (!tmdbId) return NO_TRANSLATION;
  if (ready) return ready;
  // Tant que l'attente court, la réponse en main est celle d'un autre titre.
  return settled === tmdbId ? data : undefined;
}

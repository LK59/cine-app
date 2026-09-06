"use client";

import { useCallback, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import type { CinemaProgressPayload } from "@/app/api/cinema/progress/[itemId]/route";

/**
 * « Vu » et « Favori » d'un titre — lus et écrits chez Jellyfin, jamais en base locale.
 *
 * « Vu » s'écrivait jusqu'ici dans la table `watchlist`, à côté de ce que Jellyfin savait déjà.
 * Deux versions de la même information, donc deux versions qui divergent : un film terminé sur la
 * télé restait « à voir » ici, et une liste qui ment sur la moitié de ses entrées ne sert plus à
 * rien au bout de quelques semaines.
 *
 * Le bouton manuel ne disparaît pas pour autant : un film vu au cinéma, ou revu, ou regardé par
 * quelqu'un d'autre sur le même compte, Jellyfin ne peut pas le deviner. Il corrige simplement la
 * seule vérité qui existe, au lieu d'en fabriquer une deuxième.
 *
 * Les deux bascules sont optimistes — l'état change avant la réponse — et reviennent en arrière
 * si le serveur refuse, en le disant. Attendre un aller-retour pour cocher une case donne
 * l'impression que le bouton est mort.
 */
export function useJellyfinItemState(itemId: string | null | undefined) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const key = itemId ? `/api/cinema/progress/${itemId}` : null;
  const { data, mutate } = useSWR<CinemaProgressPayload>(key, fetcher);
  /**
   * Sait-on seulement ce qu'il en est ?
   *
   * Tant que la réponse n'est pas là — ou si elle a échoué — `played` valait `false`, c'est-à-dire
   * « pas vu ». Une lecture ratée devenait donc une affirmation, sur un bouton qui *écrit* : on
   * proposait « marquer comme vu » pour un film déjà vu, et le geste changeait la donnée.
   *
   * L'ignorance se dit maintenant : les bascules attendent de savoir avant de laisser agir.
   */
  const known = data?.known ?? false;

  const toggle = useCallback(
    async (field: "played" | "favorite") => {
      // Rien tant qu'on ignore l'état : agir sur une supposition, c'est écrire une valeur qu'on
      // n'a pas lue.
      if (!itemId || !data || !data.known || busy) return;
      const next = !data[field];
      setBusy(true);
      void mutate({ ...data, [field]: next }, { revalidate: false });
      try {
        await apiAction(field === "played" ? "/api/jellyfin/played" : "/api/jellyfin/favorite", {
          method: "POST",
          body: JSON.stringify(field === "played" ? { itemId, played: next } : { itemId, favorite: next }),
        });
        void mutate();
        // « Ma liste » lit ces deux états depuis sa propre vue agrégée : sans ça, on coche
        // « vu » sur une fiche et l'onglet d'à côté l'ignore jusqu'au prochain chargement.
        void globalMutate("/api/player/lists");
      } catch (err) {
        void mutate(data, { revalidate: false });
        toast.error(err instanceof Error ? err.message : t("common.unknown"));
      } finally {
        setBusy(false);
      }
    },
    [itemId, data, busy, mutate, toast, t]
  );

  return {
    progress: data,
    known,
    watched: Boolean(data?.played),
    favorite: Boolean(data?.favorite),
    busy: busy || !known,
    toggleWatched: () => toggle("played"),
    toggleFavorite: () => toggle("favorite"),
  };
}

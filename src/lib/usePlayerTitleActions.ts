"use client";

import { useCallback, useState } from "react";
import { mutate } from "swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import type { WatchlistStatus } from "@/lib/db";

export interface PlayerTitleRef {
  tmdbId: number;
  type: "movie" | "series";
  title: string;
  year?: number | null;
  poster?: string | null;
  rating?: number | null;
}

/**
 * Les deux gestes qu'on pose sur un titre depuis le lecteur : le ranger dans une liste, et le
 * demander.
 *
 * Ils sont ensemble parce qu'ils partagent tout le reste — le même retour à l'écran, le même
 * rafraîchissement, la même façon de dire ce qui a raté. Et parce qu'ils sont *indépendants* :
 * demander n'ajoute rien à une liste, ajouter ne demande rien. Chacun écrit là où vit sa vérité
 * — la liste dans la base locale, la demande chez Jellyseerr — et personne ne recopie l'autre.
 *
 * Tout passe par `apiAction` : un 4xx ne lève pas tout seul avec `fetch`, et une action externe
 * qui échoue en silence est exactement ce que ce projet a passé une session à supprimer.
 */
export function usePlayerTitleActions(ref: PlayerTitleRef | null) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // Toutes les vues de listes, quelle que soit leur source : la watchlist locale (dont la clé
  // porte le statut demandé), la vue agrégée du lecteur, et la fiche ouverte s'il y en a une.
  // Oublier la vue agrégée était le bug le plus prévisible de ce lot : on ajoutait un titre à
  // « À voir » et l'onglet d'à côté continuait de dire qu'il n'y avait rien.
  const refreshLists = useCallback(() => {
    void mutate(
      (key) =>
        typeof key === "string" &&
        (key.startsWith("/api/watchlist") ||
          key === "/api/player/lists" ||
          key.startsWith("/api/player/title/"))
    );
  }, []);

  const setStatus = useCallback(
    async (status: WatchlistStatus | null) => {
      if (!ref || busy) return;
      setBusy(true);
      try {
        if (status === null) {
          await apiAction("/api/watchlist", {
            method: "DELETE",
            body: JSON.stringify({ tmdbId: ref.tmdbId, mediaType: ref.type }),
          });
          toast.success(t("player.actions.removedFromList"));
        } else {
          await apiAction("/api/watchlist", {
            method: "POST",
            body: JSON.stringify({
              mediaType: ref.type,
              tmdbId: ref.tmdbId,
              title: ref.title,
              year: ref.year ?? null,
              posterPath: ref.poster ?? null,
              voteAverage: ref.rating ?? null,
              status,
            }),
          });
          toast.success(t(`player.actions.addedTo.${status}`));
        }
        refreshLists();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("common.unknown"));
      } finally {
        setBusy(false);
      }
    },
    [ref, busy, toast, t, refreshLists]
  );

  const request = useCallback(async () => {
    if (!ref || busy) return;
    setBusy(true);
    try {
      await apiAction("/api/player/requests", {
        method: "POST",
        body: JSON.stringify({ type: ref.type, tmdbId: ref.tmdbId }),
      });
      toast.success(t("player.actions.requested", { title: ref.title }));
      refreshLists();
      void mutate("/api/player/requests");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.unknown"));
    } finally {
      setBusy(false);
    }
  }, [ref, busy, toast, t, refreshLists]);

  const cancelRequest = useCallback(
    async (requestId: number) => {
      if (busy) return;
      setBusy(true);
      try {
        await apiAction(`/api/player/requests/${requestId}`, { method: "DELETE" });
        toast.success(t("player.actions.requestCancelled"));
        refreshLists();
        void mutate("/api/player/requests");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("common.unknown"));
      } finally {
        setBusy(false);
      }
    },
    [busy, toast, t, refreshLists]
  );

  return { busy, setStatus, request, cancelRequest };
}

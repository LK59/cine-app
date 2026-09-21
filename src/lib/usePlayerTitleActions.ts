"use client";

import { useCallback, useState } from "react";
import { mutate } from "swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import type { WatchlistStatus } from "@/lib/db";
import { noteWatchlistChange, refreshWatchlistViews } from "@/lib/watchlistCache";

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


  /**
   * Rend `true` si c'est fait, `false` sinon — l'échec étant déjà dit par un message.
   *
   * Il ne rendait rien : l'ajout depuis « Ma liste » cochait donc la ligne quoi qu'il arrive, et
   * un ajout refusé (hors ligne, session expirée) restait affiché comme fait jusqu'à la
   * réouverture de l'écran — un message d'erreur à côté d'une coche verte.
   */
  const setStatus = useCallback(
    async (status: WatchlistStatus | null): Promise<boolean> => {
      if (!ref || busy) return false;
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
        // Le même geste que les fiches du mode cinéma, par la même fonction : la rangée « Ma
        // liste » change tout de suite, le reste se relit derrière. Voir `noteWatchlistChange`.
        noteWatchlistChange(
          { tmdbId: ref.tmdbId, mediaType: ref.type, title: ref.title, year: ref.year, posterPath: ref.poster, voteAverage: ref.rating },
          status
        );
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("common.unknown"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [ref, busy, toast, t]
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
      refreshWatchlistViews();
      void mutate("/api/player/requests");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.unknown"));
    } finally {
      setBusy(false);
    }
  }, [ref, busy, toast, t]);

  const cancelRequest = useCallback(
    async (requestId: number) => {
      if (busy) return;
      setBusy(true);
      try {
        await apiAction(`/api/player/requests/${requestId}`, { method: "DELETE" });
        toast.success(t("player.actions.requestCancelled"));
        refreshWatchlistViews();
        void mutate("/api/player/requests");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("common.unknown"));
      } finally {
        setBusy(false);
      }
    },
    [busy, toast, t]
  );

  return { busy, setStatus, request, cancelRequest };
}

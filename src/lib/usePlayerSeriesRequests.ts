"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import type { MissingPayload, MissingSeason } from "@/app/api/player/series/[sonarrId]/missing/route";

/**
 * Ce qui manque à une série, et le geste pour le demander.
 *
 * Une seule requête pour toute la série, partagée par l'écran des épisodes et la fiche : le cache
 * de SWR fait que les deux lisent la même réponse.
 *
 * Le retour est optimiste — la ligne dit « Demandé » sans attendre. C'est honnête : lancer une
 * recherche Sonarr ne garantit rien, et l'attente n'apprend donc rien de plus que le clic. Ce qui
 * compte est de savoir qu'on a bien appuyé.
 */
export function usePlayerSeriesRequests(sonarrId: number | null | undefined) {
  const t = useT();
  const toast = useToast();
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const { data, mutate } = useSWR<MissingPayload>(
    sonarrId ? `/api/player/series/${sonarrId}/missing` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const seasons = useMemo(() => data?.seasons ?? [], [data]);
  const bySeason = useMemo(() => new Map(seasons.map((s) => [s.seasonNumber, s])), [seasons]);

  const send = useCallback(
    async (body: { seasonNumber: number } | { episodeId: number }, key: string, message: string) => {
      if (!sonarrId || busy) return;
      setBusy(true);
      try {
        await apiAction(`/api/player/series/${sonarrId}/search`, { method: "POST", body: JSON.stringify(body) });
        setAsked((prev) => new Set(prev).add(key));
        toast.success(message);
        // Sonarr met un moment à récupérer quoi que ce soit : on relit plus tard, sans insister.
        setTimeout(() => void mutate(), 15_000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("common.unknown"));
      } finally {
        setBusy(false);
      }
    },
    [sonarrId, busy, toast, t, mutate]
  );

  const requestSeason = useCallback(
    (seasonNumber: number) =>
      send({ seasonNumber }, `s${seasonNumber}`, t("cinema.missing.seasonRequested", { n: seasonNumber })),
    [send, t]
  );

  const requestEpisode = useCallback(
    (episodeId: number, label: string) => send({ episodeId }, `e${episodeId}`, t("cinema.missing.episodeRequested", { label })),
    [send, t]
  );

  return {
    /** Toutes les saisons qui ont au moins un épisode absent. */
    seasons,
    seasonOf: (n: number): MissingSeason | undefined => bySeason.get(n),
    asked,
    busy,
    requestSeason,
    requestEpisode,
  };
}

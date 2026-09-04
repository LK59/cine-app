"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { useT } from "@/components/TranslationProvider";
import { usePlayerTitleActions } from "@/lib/usePlayerTitleActions";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { PlayerResultCard } from "./PlayerResultCard";
import { PlayerRequestCard } from "./PlayerRequestCard";
import type { PlayerListsPayload, PlayerListItem } from "@/app/api/player/lists/route";

type Segment = "requests" | "toWatch" | "watched" | "abandoned" | "favorites";

const SEGMENTS: Segment[] = ["requests", "toWatch", "watched", "abandoned", "favorites"];

/**
 * « Ma liste » — les cinq segments.
 *
 * Les demandes sont ici plutôt que dans une section à elles, et c'est un choix : de son côté, la
 * personne n'a qu'une question, « où sont mes trucs », et elle mérite une seule réponse. Elles
 * sont en première position parce que ce sont les seules qui bougent toutes seules, et elles
 * portent une pastille quand quelque chose est arrivé.
 *
 * Chaque segment lit sa propre source (voir /api/player/lists), mais rien de tout ça ne se voit :
 * cinq onglets, la même carte partout, et deux phrases pour dire ce qui a besoin d'être dit.
 */
export function PlayerListPanel() {
  const t = useT();
  const { data, isLoading } = useSWR<PlayerListsPayload>("/api/player/lists", fetcher, {
    revalidateOnFocus: false,
  });
  const { busy, cancelRequest } = usePlayerTitleActions(null);
  const [segment, setSegment] = useState<Segment>("requests");

  const counts = useMemo(
    () => ({
      requests: data?.requests.length ?? 0,
      toWatch: data?.toWatch.length ?? 0,
      watched: data?.watched.length ?? 0,
      abandoned: data?.abandoned.length ?? 0,
      favorites: data?.favorites.length ?? 0,
    }),
    [data]
  );

  // Ce qui vient d'arriver : c'est la seule chose de cet écran qui mérite qu'on la signale.
  const arrived = data?.requests.filter((r) => r.state === "available").length ?? 0;

  function openTitle(item: PlayerListItem) {
    if (item.libraryId === null) {
      if (item.tmdbId) cinemaNavigate({ list: false, discover: item.tmdbId, discoverType: item.type });
      return;
    }
    cinemaNavigate(item.type === "movie" ? { list: false, film: item.libraryId } : { list: false, serie: item.libraryId });
  }

  const items: PlayerListItem[] =
    segment === "requests" ? [] : (data?.[segment] ?? []);

  return (
    <PlayerPanelFrame title={t("player.nav.myList")}>
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex flex-wrap gap-2">
          {SEGMENTS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSegment(key)}
              aria-pressed={segment === key}
              className={segment === key ? "chip chip-on" : "chip"}
            >
              {t(`player.lists.${key}`)}
              <span className="ml-1.5 tabular-nums opacity-60">{counts[key]}</span>
              {key === "requests" && arrived > 0 && (
                <span
                  aria-label={t("player.lists.arrivedBadge", { n: arrived })}
                  className="ml-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-ink"
                >
                  {arrived}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Une phrase par segment qui en a besoin, à l'endroit où la question se pose. */}
        {segment === "requests" && (
          <p className="mt-5 text-sm text-slate-400">{t("player.lists.requestsHint")}</p>
        )}
        {segment === "favorites" && (
          <p className="mt-5 text-sm text-slate-400">{t("player.lists.favoritesHint")}</p>
        )}
        {segment === "watched" && (
          <p className="mt-5 text-sm text-slate-400">{t("player.lists.watchedHint")}</p>
        )}

        {isLoading && (
          <div className="mt-12 flex justify-center">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        )}

        {!isLoading && counts[segment] === 0 && (
          <p className="mt-10 text-sm text-slate-500">{t(`player.lists.empty.${segment}`)}</p>
        )}

        {segment === "requests" && counts.requests > 0 && (
          <div className="mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {data?.requests.map((r) => (
              <PlayerRequestCard
                key={r.id}
                request={r}
                busy={busy}
                onCancel={() => void cancelRequest(r.id)}
                onOpen={() =>
                  r.libraryId !== null &&
                  cinemaNavigate(r.type === "movie" ? { list: false, film: r.libraryId } : { list: false, serie: r.libraryId })
                }
              />
            ))}
          </div>
        )}

        {segment !== "requests" && items.length > 0 && (
          <div className="mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {items.map((item) => (
              <PlayerResultCard
                key={`${item.type}-${item.tmdbId ?? item.jellyfinId}`}
                kind={item.type}
                title={item.title}
                subtitle={item.year ? String(item.year) : null}
                poster={item.poster}
                missing={item.libraryId === null}
                onOpen={() => openTitle(item)}
              />
            ))}
          </div>
        )}
      </div>
    </PlayerPanelFrame>
  );
}

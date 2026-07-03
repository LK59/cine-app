"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { SubtitleSearchModal } from "@/components/SubtitleSearchModal";
import { Captions, Search } from "lucide-react";
import type { BazarrWantedMovie, BazarrWantedEpisode } from "@/lib/clients/bazarr";
import { useRole } from "@/lib/useRole";

interface WantedResponse {
  movies: { data: BazarrWantedMovie[]; total: number };
  episodes: { data: BazarrWantedEpisode[]; total: number };
}

interface ActiveSearch {
  title: string;
  searchEndpoint: string;
  downloadEndpoint: string;
  downloadExtra?: Record<string, unknown>;
}

export default function BazarrPage() {
  const { isGuest } = useRole();
  const { data, error, isLoading } = useSWR<WantedResponse>("/api/bazarr/wanted", fetcher);
  const [activeSearch, setActiveSearch] = useState<ActiveSearch | null>(null);

  return (
    <div>
      <PageHeader title="Sous-titres" subtitle="Éléments en attente de sous-titres (Bazarr)" />

      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message || "Impossible de contacter Bazarr."} />}

      {data && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-white">
              Films en attente ({data.movies.total})
            </h2>
            {data.movies.data.length === 0 ? (
              <EmptyState label="Rien en attente." />
            ) : (
              <ul className="space-y-2">
                {data.movies.data.map((movie) => (
                  <li
                    key={movie.radarrId}
                    className="flex items-center justify-between gap-2 rounded-lg bg-white/5 p-2"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <Captions size={16} className="shrink-0 text-accent-400" />
                      <div className="min-w-0">
                        <p className="truncate text-slate-200">{movie.title}</p>
                        <p className="truncate text-xs text-slate-500">
                          Manque : {movie.missing_subtitles.map((s) => s.name).join(", ")}
                        </p>
                      </div>
                    </div>
                    {!isGuest && (
                      <button
                        className="btn-ghost shrink-0 px-2 py-1 text-xs"
                        onClick={() =>
                          setActiveSearch({
                            title: `Sous-titres · ${movie.title}`,
                            searchEndpoint: `/api/bazarr/movies/${movie.radarrId}/subtitles`,
                            downloadEndpoint: `/api/bazarr/movies/${movie.radarrId}/subtitles`,
                          })
                        }
                      >
                        <Search size={12} /> Rechercher
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-white">
              Épisodes en attente ({data.episodes.total})
            </h2>
            {data.episodes.data.length === 0 ? (
              <EmptyState label="Rien en attente." />
            ) : (
              <ul className="space-y-2">
                {data.episodes.data.map((ep) => (
                  <li
                    key={ep.sonarrEpisodeId}
                    className="flex items-center justify-between gap-2 rounded-lg bg-white/5 p-2"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <Captions size={16} className="shrink-0 text-accent-400" />
                      <div className="min-w-0">
                        <p className="truncate text-slate-200">
                          {ep.seriesTitle} · {ep.episode_number}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          Manque : {ep.missing_subtitles.map((s) => s.name).join(", ")}
                        </p>
                      </div>
                    </div>
                    {!isGuest && (
                      <button
                        className="btn-ghost shrink-0 px-2 py-1 text-xs"
                        onClick={() =>
                          setActiveSearch({
                            title: `Sous-titres · ${ep.seriesTitle} ${ep.episode_number}`,
                            searchEndpoint: `/api/bazarr/episodes/${ep.sonarrEpisodeId}/subtitles`,
                            downloadEndpoint: `/api/bazarr/episodes/${ep.sonarrEpisodeId}/subtitles`,
                            downloadExtra: { seriesId: ep.sonarrSeriesId },
                          })
                        }
                      >
                        <Search size={12} /> Rechercher
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {activeSearch && (
        <SubtitleSearchModal
          title={activeSearch.title}
          searchEndpoint={activeSearch.searchEndpoint}
          downloadEndpoint={activeSearch.downloadEndpoint}
          downloadExtra={activeSearch.downloadExtra}
          onClose={() => setActiveSearch(null)}
        />
      )}
    </div>
  );
}

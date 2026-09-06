"use client";

import { ServiceNotConfigured } from "@/components/ServiceNotConfigured";
import { useConfiguredServices } from "@/lib/useConfiguredServices";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { SubtitleSearchModal } from "@/components/SubtitleSearchModal";
import { Captions, Search } from "lucide-react";
import type { BazarrWantedMovie, BazarrWantedEpisode } from "@/lib/clients/bazarr";
import { useRole } from "@/lib/useRole";
import { useT } from "@/components/TranslationProvider";

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

const PAGE_SIZE = 25;

export default function BazarrPage() {
  // Un service absent est une configuration, pas une panne : la page le dit et donne la
  // marche à suivre, au lieu de partir chercher un serveur qui n'existe pas.
  const notConfigured = !useConfiguredServices().isConfigured("bazarr");
  const { isReadOnly } = useRole();
  const t = useT();
  const [movieLength, setMovieLength] = useState(PAGE_SIZE);
  const [episodeLength, setEpisodeLength] = useState(PAGE_SIZE);
  const { data, error, isLoading, mutate } = useSWR<WantedResponse>(
    `/api/bazarr/wanted?movieLength=${movieLength}&episodeLength=${episodeLength}`,
    fetcher
  );
  const [activeSearch, setActiveSearch] = useState<ActiveSearch | null>(null);

  if (notConfigured) return <ServiceNotConfigured service="bazarr" />;

  return (
    <div>
      <PageHeader title={t('bazarr.pageTitle')} subtitle={t('bazarr.subtitle')} />

      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message || t('bazarr.serviceDown')} />}

      {data && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-white">
              {t('bazarr.moviesWanted', { n: data.movies.total })}
            </h2>
            {data.movies.data.length === 0 ? (
              <EmptyState label={t('bazarr.nothingPending')} />
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
                          {t('bazarr.missingLangs', { langs: movie.missing_subtitles.map((s) => s.name).join(", ") })}
                        </p>
                      </div>
                    </div>
                    {!isReadOnly && (
                      <button
                        className="btn-ghost shrink-0 px-2 py-1 text-xs"
                        onClick={() =>
                          setActiveSearch({
                            title: t('bazarr.modalTitle', { title: movie.title }),
                            searchEndpoint: `/api/bazarr/movies/${movie.radarrId}/subtitles`,
                            downloadEndpoint: `/api/bazarr/movies/${movie.radarrId}/subtitles`,
                          })
                        }
                      >
                        <Search size={12} /> {t('bazarr.searchButton')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.movies.data.length < data.movies.total && (
              <button
                className="btn-ghost mt-3 w-full justify-center text-xs"
                onClick={() => setMovieLength((n) => n + PAGE_SIZE)}
              >
                {t('bazarr.loadMore')}
              </button>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-white">
              {t('bazarr.episodesWanted', { n: data.episodes.total })}
            </h2>
            {data.episodes.data.length === 0 ? (
              <EmptyState label={t('bazarr.nothingPending')} />
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
                          {t('bazarr.missingLangs', { langs: ep.missing_subtitles.map((s) => s.name).join(", ") })}
                        </p>
                      </div>
                    </div>
                    {!isReadOnly && (
                      <button
                        className="btn-ghost shrink-0 px-2 py-1 text-xs"
                        onClick={() =>
                          setActiveSearch({
                            title: t('bazarr.modalTitle', { title: `${ep.seriesTitle} ${ep.episode_number}` }),
                            searchEndpoint: `/api/bazarr/episodes/${ep.sonarrEpisodeId}/subtitles`,
                            downloadEndpoint: `/api/bazarr/episodes/${ep.sonarrEpisodeId}/subtitles`,
                            downloadExtra: { seriesId: ep.sonarrSeriesId },
                          })
                        }
                      >
                        <Search size={12} /> {t('bazarr.searchButton')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.episodes.data.length < data.episodes.total && (
              <button
                className="btn-ghost mt-3 w-full justify-center text-xs"
                onClick={() => setEpisodeLength((n) => n + PAGE_SIZE)}
              >
                {t('bazarr.loadMore')}
              </button>
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
          onDownloaded={() => mutate()}
        />
      )}
    </div>
  );
}

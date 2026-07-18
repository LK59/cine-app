"use client";

import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { PosterSkeletonGrid } from "@/components/SkeletonCard";
import { ErrorState } from "@/components/StateViews";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { Film, Tv, Sparkles, SearchIcon, X } from "lucide-react";
import { PosterCard, type PosterCardItem } from "@/components/PosterCard";
import { useT } from "@/components/TranslationProvider";
import { useRole } from "@/lib/useRole";

interface DiscoverItem {
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  posterPath: string | null;
  rating: number;
  genres: string[];
  type?: "movie" | "tv";
  radarrId?: number | null;
  sonarrId?: number | null;
  inLibrary: boolean;
}

interface DiscoverData {
  items: DiscoverItem[];
  genres: string[];
}

function toPosterCardItem(item: DiscoverItem, type: "movie" | "tv"): PosterCardItem {
  const libraryHref =
    type === "movie" && item.radarrId
      ? `/radarr/${item.radarrId}`
      : type === "tv" && item.sonarrId
        ? `/sonarr/${item.sonarrId}`
        : null;
  return {
    tmdbId: item.tmdbId,
    title: item.title,
    year: item.year,
    posterUrl: item.posterPath ? `${TMDB_IMAGE_BASE}/w342${item.posterPath}` : null,
    rating: item.rating,
    inLibrary: item.inLibrary,
    libraryHref,
    pending: !item.inLibrary && !!(item.radarrId || item.sonarrId),
  };
}

function DiscoverGrid({ type }: { type: "movie" | "tv" }) {
  const endpoint = type === "movie" ? "/api/discover/movies" : "/api/discover/series";
  const { data, error, isLoading, mutate: retry } = useSWR<DiscoverData>(endpoint, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300000,
  });

  const t = useT();
  const [genreFilter, setGenreFilter] = useState("");

  const filtered = (data?.items ?? []).filter(
    (item) => !genreFilter || item.genres.includes(genreFilter)
  );

  if (isLoading) return <PosterSkeletonGrid />;
  if (error)
    return (
      <ErrorState
        message={
          error?.status === 503
            ? t('discover.apiKeyMissing')
            : error.message
        }
        onRetry={() => retry()}
      />
    );

  return (
    <div>
      {data && data.genres.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          <button
            onClick={() => setGenreFilter("")}
            className={`badge cursor-pointer transition-colors ${
              !genreFilter
                ? "bg-accent-600/20 text-accent-400 ring-1 ring-accent-500/30"
                : "bg-white/5 text-slate-400 hover:text-slate-200"
            }`}
          >
            {t('discover.genreAll')}
          </button>
          {data.genres.map((g) => (
            <button
              key={g}
              onClick={() => setGenreFilter(g === genreFilter ? "" : g)}
              className={`badge cursor-pointer transition-colors ${
                genreFilter === g
                  ? "bg-accent-600/20 text-accent-400 ring-1 ring-accent-500/30"
                  : "bg-white/5 text-slate-400 hover:text-slate-200"
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <p className="text-sm text-slate-500">{t('discover.noResultsGenre')}</p>
      )}

      <div className="poster-grid">
        {filtered.map((item) => (
          <PosterCard
            key={item.tmdbId}
            item={toPosterCardItem(item, type)}
            mediaType={type === "tv" ? "series" : "movie"}
          />
        ))}
      </div>
    </div>
  );
}

interface RecoData {
  items: (DiscoverItem & { type: "movie" | "tv" })[];
  hasHistory: boolean;
}

function RecommendationsGrid() {
  const { data, error, isLoading, mutate: retry } = useSWR<RecoData>("/api/discover/recommendations", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300000,
  });
  const t = useT();

  if (isLoading) return <PosterSkeletonGrid />;
  if (error) return <ErrorState message={t('common.serviceDown', { service: 'TMDB' })} onRetry={() => retry()} />;
  if (!data?.hasHistory) {
    return (
      <div className="mt-12 flex flex-col items-center gap-3 text-center">
        <Sparkles size={36} className="text-slate-600" />
        <p className="text-sm text-slate-400">
          {t('recommendations.empty')}
        </p>
      </div>
    );
  }
  if (data.items.length === 0) {
    return <p className="text-sm text-slate-500">{t('discover.libraryComplete')}</p>;
  }

  return (
    <div>
      <div className="poster-grid">
        {data.items.map((item) => (
          <PosterCard
            key={`${item.type}-${item.tmdbId}`}
            item={toPosterCardItem(item, item.type)}
            mediaType={item.type === "tv" ? "series" : "movie"}
          />
        ))}
      </div>
    </div>
  );
}

function SearchGrid({ query, type }: { query: string; type: "movie" | "tv" }) {
  const endpoint = query.length >= 2 ? `/api/discover/search?q=${encodeURIComponent(query)}&type=${type}` : null;
  const { data, isLoading } = useSWR<{ items: DiscoverItem[] }>(endpoint, fetcher, {
    dedupingInterval: 10000,
    keepPreviousData: true,
  });
  const t = useT();

  if (query.length < 2) {
    return (
      <div className="mt-16 flex flex-col items-center gap-2 text-center text-slate-500">
        <SearchIcon size={32} className="text-slate-700" />
        <p className="text-sm">{t('discover.searchMinChars')}</p>
      </div>
    );
  }

  if (isLoading) return <PosterSkeletonGrid />;
  if (!data?.items.length) return <p className="mt-8 text-center text-sm text-slate-500">{t('discover.noSearchResults', { query })}</p>;

  return (
    <div>
      <div className="poster-grid">
        {data.items.map((item) => (
          <PosterCard
            key={item.tmdbId}
            item={toPosterCardItem(item, type)}
            mediaType={type === "tv" ? "series" : "movie"}
          />
        ))}
      </div>
    </div>
  );
}

export default function DiscoverPage() {
  const [tab, setTab] = useState<"movie" | "tv" | "pour-vous">("movie");
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const { jfId } = useRole();
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce: update query 400ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => setQuery(rawQuery.trim()), 400);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  const isSearching = rawQuery.length > 0;
  const searchType = tab === "pour-vous" ? "movie" : tab;

  return (
    <div>
      <PageHeader
        title={t('discover.pageTitle')}
        subtitle={t('discover.subtitle')}
      />

      {/* Search bar */}
      <div className="relative mb-5">
        <SearchIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          ref={inputRef}
          type="text"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          placeholder={t('discover.searchPlaceholder')}
          className="w-full rounded-lg border border-white/10 bg-slate-800/60 py-2.5 pl-9 pr-9 text-sm text-white placeholder:text-slate-500 focus:border-accent-500/50 focus:outline-hidden focus:ring-1 focus:ring-accent-500/30"
        />
        {rawQuery && (
          <button
            onClick={() => { setRawQuery(""); setQuery(""); inputRef.current?.focus(); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* Tabs — always visible, act as type selector during search */}
      <div className="mb-6 flex gap-2">
        {jfId && !isSearching && (
          <button
            onClick={() => setTab("pour-vous")}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === "pour-vous"
                ? "bg-accent-600/15 text-accent-400 ring-1 ring-inset ring-accent-500/20"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
            }`}
          >
            <Sparkles size={16} />
            {t('discover.tabForYou')}
          </button>
        )}
        <button
          onClick={() => setTab("movie")}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            (isSearching ? searchType === "movie" : tab === "movie")
              ? "bg-accent-600/15 text-accent-400 ring-1 ring-inset ring-accent-500/20"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
          }`}
        >
          <Film size={16} />
          {t('discover.tabMovies')}
        </button>
        <button
          onClick={() => setTab("tv")}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            (isSearching ? searchType === "tv" : tab === "tv")
              ? "bg-accent-600/15 text-accent-400 ring-1 ring-inset ring-accent-500/20"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
          }`}
        >
          <Tv size={16} />
          {t('discover.tabSeries')}
        </button>
      </div>

      {isSearching ? (
        <SearchGrid query={query} type={searchType === "tv" ? "tv" : "movie"} />
      ) : (
        <>
          {tab === "pour-vous" && <RecommendationsGrid />}
          {tab === "movie" && <DiscoverGrid type="movie" />}
          {tab === "tv" && <DiscoverGrid type="tv" />}
        </>
      )}
    </div>
  );
}

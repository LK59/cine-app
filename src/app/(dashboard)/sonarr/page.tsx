"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocalState } from "@/hooks/useLocalState";
import Link from "next/link";
import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { PosterSkeletonGrid } from "@/components/SkeletonCard";
import { Modal } from "@/components/Modal";
import { Plus, Search, Tv, ChevronDown, LayoutGrid, List } from "lucide-react";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import { posterUrl } from "@/lib/images";
import { useRole } from "@/lib/useRole";
import { prefetchSeriesDetail } from "@/lib/prefetch";
import { useListKeyNav } from "@/lib/useListKeyNav";
import { useToast } from "@/components/Toast";
import { PosterImage } from "@/components/PosterImage";
import { useT } from "@/components/TranslationProvider";

function poster(series: SonarrSeries) {
  return posterUrl(series.images);
}

type SortKey = "added" | "title" | "year" | "episodes";
type StatusFilter = "all" | "complete" | "missing" | "continuing" | "ended";
type ViewMode = "grid" | "list";
type DecadeFilter = "all" | "2020s" | "2010s" | "2000s" | "1990s" | "older";

function decadeOf(year: number): DecadeFilter {
  if (year >= 2020) return "2020s";
  if (year >= 2010) return "2010s";
  if (year >= 2000) return "2000s";
  if (year >= 1990) return "1990s";
  return "older";
}

import { relDate } from "@/lib/format";

export default function SonarrPage() {
  const { mutate } = useSWRConfig();
  const { isGuest } = useRole();
  const toast = useToast();
  const t = useT();
  const { data: series, error, isLoading } = useSWR<SonarrSeries[]>("/api/sonarr/series", fetcher);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useLocalState<SortKey>("sonarr-sort", "added");
  const [statusFilter, setStatusFilter] = useLocalState<StatusFilter>("sonarr-status", "all");
  const [genreFilter, setGenreFilter] = useLocalState("sonarr-genre", "");
  const [decadeFilter, setDecadeFilter] = useLocalState<DecadeFilter>("sonarr-decade", "all");
  const [view, setView] = useLocalState<ViewMode>("sonarr-view", "grid");

  const genres = useMemo(() => {
    if (!series) return [];
    const set = new Set<string>();
    for (const s of series) {
      for (const g of s.genres ?? []) set.add(g);
    }
    return [...set].sort();
  }, [series]);

  const filtered = useMemo(() => {
    if (!series) return [];
    const term = search.trim().toLowerCase();
    let list = series.filter((s) => {
      if (term && !s.title.toLowerCase().includes(term)) return false;
      if (statusFilter === "complete") {
        const complete =
          (s.statistics?.episodeFileCount ?? 0) >= (s.statistics?.episodeCount ?? 1);
        if (!complete) return false;
      }
      if (statusFilter === "missing") {
        const hasMissing =
          (s.statistics?.episodeFileCount ?? 0) < (s.statistics?.episodeCount ?? 0);
        if (!hasMissing) return false;
      }
      if (statusFilter === "continuing" && s.status !== "continuing") return false;
      if (statusFilter === "ended" && s.status !== "ended") return false;
      if (genreFilter && !(s.genres ?? []).includes(genreFilter)) return false;
      if (decadeFilter !== "all" && decadeOf(s.year) !== decadeFilter) return false;
      return true;
    });

    list = [...list].sort((a, b) => {
      if (sort === "added") return (b.added ?? "").localeCompare(a.added ?? "");
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "year") return (b.year ?? 0) - (a.year ?? 0);
      if (sort === "episodes") {
        return (b.statistics?.episodeFileCount ?? 0) - (a.statistics?.episodeFileCount ?? 0);
      }
      return 0;
    });

    return list;
  }, [series, search, sort, statusFilter, genreFilter, decadeFilter]);

  const navCursor = useListKeyNav(filtered.length, (i) => `/sonarr/${filtered[i]?.id}`);

  const PAGE = 60;
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setVisibleCount(PAGE); }, [filtered]);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisibleCount((n) => n + PAGE); },
      { rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const visible = filtered.slice(0, visibleCount);

  return (
    <div>
      <PageHeader
        title={t('sonarr.pageTitle')}
        subtitle={series ? t('sonarr.subtitle', { n: series.length }) : undefined}
        action={
          <button className="btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={16} /> {t('sonarr.addSeries')}
          </button>
        }
      />

      {isLoading && <PosterSkeletonGrid />}
      {error && <ErrorState message={t('sonarr.serviceDown')} onRetry={() => mutate("/api/sonarr/series")} />}
      {series && series.length === 0 && <EmptyState label={t('sonarr.noSeries')} />}

      {series && series.length > 0 && (
        <>
          {/* Search + filters */}
          <div className="mb-4 space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:max-w-xs sm:flex-none">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  className="input w-full pl-8"
                  placeholder={t('sonarr.searchPlaceholder')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="ml-auto flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
                <button
                  onClick={() => setView("grid")}
                  className={`rounded-sm p-1 transition-colors ${view === "grid" ? "bg-white/15 text-white" : "text-slate-500 hover:text-slate-300"}`}
                  title={t('common.viewGrid')}
                >
                  <LayoutGrid size={15} />
                </button>
                <button
                  onClick={() => setView("list")}
                  className={`rounded-sm p-1 transition-colors ${view === "list" ? "bg-white/15 text-white" : "text-slate-500 hover:text-slate-300"}`}
                  title={t('common.viewList')}
                >
                  <List size={15} />
                </button>
              </div>
            </div>

            {/* Filter selects — horizontal scroll on mobile, wrap on desktop */}
            <div className="scrollbar-none flex gap-2 overflow-x-auto pb-0.5 [touch-action:pan-x] sm:flex-wrap sm:overflow-visible">
              <div className="relative shrink-0">
                <select className="input appearance-none pr-7 text-sm" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="added">{t('common.sortRecentlyAdded')}</option>
                  <option value="title">{t('common.sortTitleAZ')}</option>
                  <option value="year">{t('common.sortYear')}</option>
                  <option value="episodes">{t('common.sortEpisodes')}</option>
                </select>
                <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
              <div className="relative shrink-0">
                <select className="input appearance-none pr-7 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                  <option value="all">{t('sonarr.statusAll')}</option>
                  <option value="complete">{t('sonarr.statusComplete')}</option>
                  <option value="missing">{t('sonarr.statusMissing')}</option>
                  <option value="continuing">{t('sonarr.statusContinuing')}</option>
                  <option value="ended">{t('sonarr.statusEnded')}</option>
                </select>
                <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
              {genres.length > 0 && (
                <div className="relative shrink-0">
                  <select className="input appearance-none pr-7 text-sm" value={genreFilter} onChange={(e) => setGenreFilter(e.target.value)}>
                    <option value="">{t('common.allGenres')}</option>
                    {genres.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                  <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
                </div>
              )}
              <div className="relative shrink-0">
                <select className="input appearance-none pr-7 text-sm" value={decadeFilter} onChange={(e) => setDecadeFilter(e.target.value as DecadeFilter)}>
                  <option value="all">{t('common.allDecades')}</option>
                  <option value="2020s">2020s</option>
                  <option value="2010s">2010s</option>
                  <option value="2000s">2000s</option>
                  <option value="1990s">1990s</option>
                  <option value="older">{t('common.decadeBefore1990')}</option>
                </select>
                <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            </div>
          </div>

          {filtered.length === 0 && (
            <EmptyState label={t('sonarr.noResults')} />
          )}

          {view === "grid" ? (
            <>
              <div className="poster-grid">
                {visible.map((show, i) => (
                  <div key={show.id} className="group/card relative [content-visibility:auto] [contain-intrinsic-size:0_320px]">
                    <Link
                      href={`/sonarr/${show.id}`}
                      data-nav-idx={i}
                      onMouseEnter={() => prefetchSeriesDetail(show.id)}
                      onFocus={() => prefetchSeriesDetail(show.id)}
                      className={`card group relative block overflow-hidden transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-glow ${navCursor === i ? "ring-2 ring-accent-500" : ""}`}
                    >
                      <PosterImage src={poster(show)} alt={show.title} />
                      <div className="p-2">
                        <p className="truncate text-xs font-medium text-white">{show.title}</p>
                        <p className="text-xs text-slate-500">
                          {t('sonarr.episodesCount', { file: show.statistics?.episodeFileCount ?? 0, total: show.statistics?.episodeCount ?? 0 })}
                        </p>
                      </div>
                    </Link>
                    {(show.overview || (show.genres?.length ?? 0) > 0) && (
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-56 -translate-x-1/2 rounded-xl border border-white/10 bg-slate-900/95 p-3 opacity-0 shadow-xl backdrop-blur-xs transition-opacity duration-150 group-hover/card:opacity-100 [@media(hover:hover)]:block">
                        <p className="mb-0.5 text-xs font-semibold leading-tight text-white">{show.title}</p>
                        <p className="mb-2 text-[10px] text-slate-500">
                          {show.year} · {show.statistics?.episodeCount ?? 0} épisodes
                        </p>
                        {(show.genres?.length ?? 0) > 0 && (
                          <div className="mb-2 flex flex-wrap gap-1">
                            {show.genres!.slice(0, 3).map((g) => (
                              <span key={g} className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] text-slate-300">{g}</span>
                            ))}
                          </div>
                        )}
                        {show.overview && (
                          <p className="line-clamp-3 text-[10px] leading-4 text-slate-400">{show.overview}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div ref={sentinelRef} className="h-1" />
              {visibleCount < filtered.length && (
                <p className="py-4 text-center text-xs text-slate-600">{t('sonarr.remainingSeries', { n: filtered.length - visibleCount })}</p>
              )}
            </>
          ) : (
            <>
              <div className="card divide-y divide-white/5">
                {visible.map((show, i) => {
                  const complete = (show.statistics?.episodeFileCount ?? 0) >= (show.statistics?.episodeCount ?? 1);
                  return (
                    <Link
                      key={show.id}
                      href={`/sonarr/${show.id}`}
                      data-nav-idx={i}
                      onMouseEnter={() => prefetchSeriesDetail(show.id)}
                      onFocus={() => prefetchSeriesDetail(show.id)}
                      className={`group flex items-center gap-3 p-3 hover:bg-white/5 ${navCursor === i ? "bg-white/10" : ""}`}
                    >
                      <PosterImage src={poster(show)} alt={show.title} aspectRatio="" className="h-14 w-10 shrink-0 rounded-sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{show.title}</p>
                        <p className="text-xs text-slate-500">{show.year}</p>
                      </div>
                      <div className="hidden items-center gap-3 sm:flex">
                        <span className={`badge ${complete ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`}>
                          {show.statistics?.episodeFileCount ?? 0}/{show.statistics?.episodeCount ?? 0} ép.
                        </span>
                        <span className="text-xs text-slate-600">{relDate(show.added, t)}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
              <div ref={sentinelRef} className="h-1" />
              {visibleCount < filtered.length && (
                <p className="py-4 text-center text-xs text-slate-600">{t('sonarr.remainingSeries', { n: filtered.length - visibleCount })}</p>
              )}
            </>
          )}
        </>
      )}

      {showAdd && <AddSeriesModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function AddSeriesModal({ onClose }: { onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SonarrSeries[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const toast = useToast();
  const t = useT();

  const { data: meta } = useSWR<{ qualityProfiles: { id: number; name: string }[]; rootFolders: { id: number; path: string }[] }>(
    "/api/sonarr/meta",
    fetcher
  );

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/sonarr/series/lookup?term=${encodeURIComponent(term)}`);
      setResults(await res.json());
    } finally {
      setSearching(false);
    }
  }

  async function add(show: SonarrSeries) {
    if (!meta?.qualityProfiles?.length || !meta?.rootFolders?.length) return;
    if (show.id) {
      toast.error(t('sonarr.alreadyInSonarr'));
      return;
    }
    setAdding(show.tvdbId);
    try {
      await fetch("/api/sonarr/series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...show,
          qualityProfileId: meta.qualityProfiles[0].id,
          rootFolderPath: meta.rootFolders[0].path,
          monitored: true,
          addOptions: { searchForMissingEpisodes: true },
        }),
      });
      mutate("/api/sonarr/series");
      setAdded((prev) => new Set(prev).add(show.tvdbId));
      toast.success(t('sonarr.addedToSonarr', { title: show.title }));
    } catch {
      toast.error(t('sonarr.addFailed'));
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal title={t('sonarr.addSeries')} onClose={onClose}>
      <form onSubmit={handleSearch} className="mb-4 flex gap-2">
        <input
          className="input"
          placeholder={t('sonarr.addSeriesPlaceholder')}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          autoFocus
        />
        <button className="btn-primary shrink-0" type="submit" disabled={searching}>
          <Search size={16} />
        </button>
      </form>

      {searching && <LoadingState />}

      {results.length > 0 && !searching && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {results.map((show) => {
            const inLibrary = Boolean(show.id);
            const isAdded = added.has(show.tvdbId);
            return (
              <div key={show.tvdbId} className="card overflow-hidden">
                <div className="relative aspect-2/3 bg-slate-800">
                  {show.remotePoster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={show.remotePoster}
                      alt={show.title}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-slate-600">
                      <Tv size={32} />
                    </div>
                  )}
                  {inLibrary && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <span className="text-xs font-semibold text-emerald-400">{t('sonarr.alreadyAdded')}</span>
                    </div>
                  )}
                </div>
                <div className="p-2">
                  <p className="line-clamp-2 text-xs font-medium leading-snug text-white">{show.title}</p>
                  <p className="mb-2 text-[11px] text-slate-500">{show.year}</p>
                  <button
                    className="btn-primary w-full text-xs"
                    disabled={adding === show.tvdbId || inLibrary || isAdded}
                    onClick={() => add(show)}
                  >
                    {adding === show.tvdbId
                      ? t('common.adding')
                      : inLibrary || isAdded
                        ? t('sonarr.alreadyAdded')
                        : t('common.add')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

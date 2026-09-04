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
import { Plus, Search, Film, ChevronDown, LayoutGrid, List } from "lucide-react";
import type { RadarrMovie } from "@/lib/clients/radarr";
import { posterUrl } from "@/lib/images";
import { useRole } from "@/lib/useRole";
import { prefetchMovieDetail } from "@/lib/prefetch";
import { useListKeyNav } from "@/lib/useListKeyNav";
import { useToast } from "@/components/Toast";
import { PosterImage } from "@/components/PosterImage";
import { ImdbBadge } from "@/components/ImdbBadge";
import { useT } from "@/components/TranslationProvider";

function poster(movie: RadarrMovie) {
  return posterUrl(movie.images);
}

import { fmtSize, relDate } from "@/lib/format";

type SortKey = "added" | "title" | "year" | "size" | "rating";
type StatusFilter = "all" | "downloaded" | "missing";
type ViewMode = "grid" | "list";
type DecadeFilter = "all" | "2020s" | "2010s" | "2000s" | "1990s" | "older";
type QualityFilter = "all" | "4K" | "1080p" | "720p" | "missing";

function qualityBucket(name: string | undefined): string {
  if (!name) return "missing";
  const n = name.toLowerCase();
  if (n.includes("2160") || n.includes("4k") || n.includes("uhd") || n.includes("remux")) return "4K";
  if (n.includes("1080")) return "1080p";
  if (n.includes("720")) return "720p";
  return "other";
}

function decadeOf(year: number): DecadeFilter {
  if (year >= 2020) return "2020s";
  if (year >= 2010) return "2010s";
  if (year >= 2000) return "2000s";
  if (year >= 1990) return "1990s";
  return "older";
}

export default function RadarrPage() {
  const t = useT();
  const { mutate } = useSWRConfig();
  const { isGuest } = useRole();
  const toast = useToast();
  const { data: movies, error, isLoading } = useSWR<RadarrMovie[]>("/api/radarr/movies", fetcher);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useLocalState<SortKey>("radarr-sort", "added");
  const [statusFilter, setStatusFilter] = useLocalState<StatusFilter>("radarr-status", "all");
  const [genreFilter, setGenreFilter] = useLocalState("radarr-genre", "");
  const [decadeFilter, setDecadeFilter] = useLocalState<DecadeFilter>("radarr-decade", "all");
  const [qualityFilter, setQualityFilter] = useLocalState<QualityFilter>("radarr-quality", "all");
  const [view, setView] = useLocalState<ViewMode>("radarr-view", "grid");

  const genres = useMemo(() => {
    if (!movies) return [];
    const set = new Set<string>();
    for (const m of movies) {
      for (const g of m.genres ?? []) set.add(g);
    }
    return [...set].sort();
  }, [movies]);

  const filtered = useMemo(() => {
    if (!movies) return [];
    const term = search.trim().toLowerCase();
    let list = movies.filter((m) => {
      if (term && !m.title.toLowerCase().includes(term)) return false;
      if (statusFilter === "downloaded" && !m.hasFile) return false;
      if (statusFilter === "missing" && m.hasFile) return false;
      if (genreFilter && !(m.genres ?? []).includes(genreFilter)) return false;
      if (decadeFilter !== "all" && decadeOf(m.year) !== decadeFilter) return false;
      if (qualityFilter !== "all") {
        const bucket = qualityBucket(m.movieFile?.quality?.quality?.name);
        if (qualityFilter === "4K" && bucket !== "4K") return false;
        if (qualityFilter === "1080p" && bucket !== "1080p") return false;
        if (qualityFilter === "720p" && bucket !== "720p") return false;
        if (qualityFilter === "missing" && m.hasFile) return false;
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      if (sort === "added") {
        return (b.added ?? "").localeCompare(a.added ?? "");
      }
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "year") return (b.year ?? 0) - (a.year ?? 0);
      if (sort === "size") return (b.sizeOnDisk ?? 0) - (a.sizeOnDisk ?? 0);
      if (sort === "rating") return (b.ratings?.imdb?.value ?? 0) - (a.ratings?.imdb?.value ?? 0);
      return 0;
    });

    return list;
  }, [movies, search, sort, statusFilter, genreFilter, decadeFilter, qualityFilter]);

  const navCursor = useListKeyNav(filtered.length, (i) => `/radarr/${filtered[i]?.id}`);

  const PAGE = 60;
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset pagination when filters change — applied during render (not in an effect) per
  // React's guidance for adjusting state from a computed value change.
  const [resetForFiltered, setResetForFiltered] = useState(filtered);
  if (filtered !== resetForFiltered) {
    setResetForFiltered(filtered);
    setVisibleCount(PAGE);
  }

  // Infinite scroll: load more when sentinel enters viewport
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
        title={t('radarr.pageTitle')}
        subtitle={movies ? t('radarr.subtitle', { n: movies.length }) : undefined}
        action={
          !isGuest && (
            <button className="btn-primary" onClick={() => setShowAdd(true)}>
              <Plus size={16} /> {t('radarr.addMovie')}
            </button>
          )
        }
      />

      {isLoading && <PosterSkeletonGrid />}
      {error && <ErrorState message={t('radarr.serviceDown')} onRetry={() => mutate("/api/radarr/movies")} />}
      {movies && movies.length === 0 && <EmptyState label={t('radarr.noMovies')} />}

      {movies && movies.length > 0 && (
        <>
          {/* Search + filters */}
          <div className="mb-4 space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:max-w-xs sm:flex-none">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  className="input w-full pl-8"
                  placeholder={t('radarr.searchPlaceholder')}
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
                  <option value="size">{t('common.sortSize')}</option>
                  <option value="rating">{t('common.sortImdbRating')}</option>
                </select>
                <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
              <div className="relative shrink-0">
                <select className="input appearance-none pr-7 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                  <option value="all">{t('radarr.statusAll')}</option>
                  <option value="downloaded">{t('radarr.statusDownloaded')}</option>
                  <option value="missing">{t('radarr.statusMissing')}</option>
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
              <div className="relative shrink-0">
                <select className="input appearance-none pr-7 text-sm" value={qualityFilter} onChange={(e) => setQualityFilter(e.target.value as QualityFilter)}>
                  <option value="all">{t('common.allQualities')}</option>
                  <option value="4K">{t('radarr.quality4K')}</option>
                  <option value="1080p">1080p</option>
                  <option value="720p">720p</option>
                  <option value="missing">{t('common.notDownloaded')}</option>
                </select>
                <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            </div>
          </div>

          {filtered.length === 0 && (
            <EmptyState label={t('radarr.noResults')} />
          )}

          {view === "grid" ? (
            <>
              <div className="poster-grid">
                {visible.map((movie, i) => (
                  <div key={movie.id} className="group/card relative [content-visibility:auto] [contain-intrinsic-size:0_320px]">
                    <Link
                      href={`/radarr/${movie.id}`}
                      data-nav-idx={i}
                      onMouseEnter={() => prefetchMovieDetail(movie.id)}
                      onFocus={() => prefetchMovieDetail(movie.id)}
                      className={`card-solid group relative block overflow-hidden transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-glow ${navCursor === i ? "ring-2 ring-accent-500" : ""}`}
                    >
                      <PosterImage src={poster(movie)} alt={movie.title} />
                      {movie.ratings?.imdb?.value != null && (
                        <ImdbBadge rating={movie.ratings.imdb.value} className="absolute left-2 top-2 shadow" />
                      )}
                      <div className="p-2">
                        <p className="truncate text-xs font-medium text-white">{movie.title}</p>
                        <p className="text-xs text-slate-500">{movie.year}</p>
                      </div>
                      <span
                        className={`absolute right-2 top-2 h-2 w-2 rounded-full ${movie.hasFile ? "bg-emerald-400" : "bg-amber-400"}`}
                        title={movie.hasFile ? "Téléchargé" : "Manquant"}
                      />
                    </Link>
                    {(movie.overview || (movie.genres?.length ?? 0) > 0) && (
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-56 -translate-x-1/2 rounded-xl border border-white/10 bg-slate-900/95 p-3 opacity-0 shadow-xl backdrop-blur-xs transition-opacity duration-150 group-hover/card:opacity-100 [@media(hover:hover)]:block">
                        <p className="mb-0.5 text-xs font-semibold leading-tight text-white">{movie.title}</p>
                        <p className="mb-2 text-[10px] text-slate-500">{movie.year}</p>
                        {(movie.genres?.length ?? 0) > 0 && (
                          <div className="mb-2 flex flex-wrap gap-1">
                            {movie.genres!.slice(0, 3).map((g) => (
                              <span key={g} className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] text-slate-300">{g}</span>
                            ))}
                          </div>
                        )}
                        {movie.overview && (
                          <p className="line-clamp-3 text-[10px] leading-4 text-slate-400">{movie.overview}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div ref={sentinelRef} className="h-1" />
              {visibleCount < filtered.length && (
                <p className="py-4 text-center text-xs text-slate-600">{filtered.length - visibleCount} films restants…</p>
              )}
            </>
          ) : (
            <>
              <div className="card divide-y divide-white/5">
                {visible.map((movie, i) => (
                  <Link
                    key={movie.id}
                    href={`/radarr/${movie.id}`}
                    data-nav-idx={i}
                    onMouseEnter={() => prefetchMovieDetail(movie.id)}
                    onFocus={() => prefetchMovieDetail(movie.id)}
                    className={`group flex items-center gap-3 p-3 hover:bg-white/5 ${navCursor === i ? "bg-white/10" : ""}`}
                  >
                    <PosterImage src={poster(movie)} alt={movie.title} aspectRatio="" className="h-14 w-10 shrink-0 rounded-sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{movie.title}</p>
                      <p className="text-xs text-slate-500">{movie.year}</p>
                    </div>
                    <div className="hidden items-center gap-3 sm:flex">
                      <ImdbBadge rating={movie.ratings?.imdb?.value} />
                      <span className={`badge ${movie.hasFile ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`}>
                        {movie.hasFile ? "Téléchargé" : "Manquant"}
                      </span>
                      {movie.sizeOnDisk > 0 && (
                        <span className="text-xs text-slate-500">{fmtSize(movie.sizeOnDisk)}</span>
                      )}
                      <span className="text-xs text-slate-600">{relDate(movie.added, t)}</span>
                    </div>
                  </Link>
                ))}
              </div>
              <div ref={sentinelRef} className="h-1" />
              {visibleCount < filtered.length && (
                <p className="py-4 text-center text-xs text-slate-600">{filtered.length - visibleCount} films restants…</p>
              )}
            </>
          )}
        </>
      )}

      {showAdd && <AddMovieModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function AddMovieModal({ onClose }: { onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<RadarrMovie[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const toast = useToast();

  const { data: meta } = useSWR<{ qualityProfiles: { id: number; name: string }[]; rootFolders: { id: number; path: string }[] }>(
    "/api/radarr/meta",
    fetcher
  );

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/radarr/movies/lookup?term=${encodeURIComponent(term)}`);
      setResults(await res.json());
    } finally {
      setSearching(false);
    }
  }

  async function add(movie: RadarrMovie) {
    if (!meta?.qualityProfiles?.length || !meta?.rootFolders?.length) return;
    if (movie.id) {
      toast.error("Ce film est déjà dans Radarr");
      return;
    }
    setAdding(movie.tmdbId);
    try {
      await fetch("/api/radarr/movies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...movie,
          qualityProfileId: meta.qualityProfiles[0].id,
          rootFolderPath: meta.rootFolders[0].path,
          monitored: true,
          addOptions: { searchForMovie: true },
        }),
      });
      mutate("/api/radarr/movies");
      setAdded((prev) => new Set(prev).add(movie.tmdbId));
      toast.success(`« ${movie.title} » ajouté à Radarr`);
    } catch {
      toast.error("Échec de l'ajout");
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal title="Ajouter un film" onClose={onClose}>
      <form onSubmit={handleSearch} className="mb-4 flex gap-2">
        <input
          className="input"
          placeholder="Titre du film..."
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
          {results.map((movie) => {
            const inLibrary = Boolean(movie.id);
            const isAdded = added.has(movie.tmdbId);
            return (
              <div key={movie.tmdbId} className="card-solid overflow-hidden">
                <div className="relative aspect-2/3 bg-slate-800">
                  {movie.remotePoster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={movie.remotePoster}
                      alt={movie.title}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-slate-600">
                      <Film size={32} />
                    </div>
                  )}
                  {inLibrary && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <span className="text-xs font-semibold text-emerald-400">Déjà ajouté</span>
                    </div>
                  )}
                </div>
                <div className="p-2">
                  <p className="line-clamp-2 text-xs font-medium leading-snug text-white">{movie.title}</p>
                  <p className="mb-2 text-[11px] text-slate-500">{movie.year}</p>
                  <button
                    className="btn-primary w-full text-xs"
                    disabled={adding === movie.tmdbId || inLibrary || isAdded}
                    onClick={() => add(movie)}
                  >
                    {adding === movie.tmdbId
                      ? "Ajout…"
                      : inLibrary || isAdded
                        ? "Déjà ajouté"
                        : "Ajouter"}
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

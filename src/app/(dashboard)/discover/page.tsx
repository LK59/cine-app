"use client";

import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { useRole } from "@/lib/useRole";
import { useToast } from "@/components/Toast";
import { ReleaseSearchModal } from "@/components/ReleaseSearchModal";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { Film, Tv, Star, BookCheck, Telescope, Sparkles, SearchIcon, X, Eye, Heart, Clock, CheckCircle2, PlusCircle, ExternalLink } from "lucide-react";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import type { WatchlistStatus } from "@/lib/db";

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

interface ReleaseModal {
  title: string;
  searchEndpoint: string;
  grabEndpoint: string;
}

// ─── Status meta ──────────────────────────────────────────────────────────────

const STATUS_META: Record<WatchlistStatus, {
  label: string;
  icon: React.ElementType;
  textColor: string;
  bgSolid: string;
}> = {
  to_watch:   { label: "À voir",     icon: Eye,          textColor: "text-sky-400",     bgSolid: "bg-sky-500" },
  to_request: { label: "À demander", icon: Clock,        textColor: "text-amber-400",   bgSolid: "bg-amber-500" },
  favorite:   { label: "Favoris",    icon: Heart,        textColor: "text-rose-400",    bgSolid: "bg-rose-500" },
  watched:    { label: "Vus",        icon: CheckCircle2, textColor: "text-emerald-400", bgSolid: "bg-emerald-500" },
  abandoned:  { label: "Abandonnés", icon: X,            textColor: "text-slate-400",   bgSolid: "bg-slate-500" },
};

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "favorite", "watched", "to_request", "abandoned"];

// ─── PosterCard ───────────────────────────────────────────────────────────────

function PosterCard({
  item,
  type,
  onRequest,
  onInteractiveSearch,
  isAdmin,
  requesting,
  requested,
}: {
  item: DiscoverItem;
  type: "movie" | "tv";
  onRequest: (item: DiscoverItem) => void;
  onInteractiveSearch: (item: DiscoverItem) => void;
  isAdmin: boolean;
  requesting: boolean;
  requested: boolean;
}) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [addedStatus, setAddedStatus] = useState<WatchlistStatus | null>(null);

  const libraryHref =
    type === "movie" && item.radarrId
      ? `/radarr/${item.radarrId}`
      : type === "tv" && item.sonarrId
        ? `/sonarr/${item.sonarrId}`
        : null;

  async function addToWatchlist(status: WatchlistStatus) {
    setAddedStatus(status);
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdbId: item.tmdbId,
        mediaType: type === "movie" ? "movie" : "series",
        title: item.title,
        year: item.year,
        posterPath: item.posterPath,
        voteAverage: item.rating ?? null,
        status,
      }),
    });
  }

  function handlePosterClick() {
    if (window.matchMedia("(pointer: coarse)").matches) {
      setSheetOpen(true);
    } else if (libraryHref) {
      router.push(libraryHref);
    }
  }

  const AddedIcon = addedStatus ? STATUS_META[addedStatus].icon : null;

  const sheetActions: SheetAction[] = [
    ...ALL_STATUSES.map((s) => {
      const meta = STATUS_META[s];
      const Icon = meta.icon;
      return {
        label: meta.label,
        icon: <Icon size={16} />,
        onClick: () => addToWatchlist(s),
        variant: (addedStatus === s ? "accent" : "default") as "accent" | "default",
        disabled: addedStatus === s,
      };
    }),
    ...(libraryHref
      ? [{ label: "Voir la fiche", icon: <ExternalLink size={16} />, onClick: () => router.push(libraryHref) }]
      : [{
          label: requested ? "Demande envoyée ✓" : requesting ? "Envoi…" : "Demander",
          icon: <PlusCircle size={16} />,
          onClick: () => onRequest(item),
          disabled: requested || requesting,
          variant: requested ? "accent" as const : "default" as const,
        }]
    ),
    ...(isAdmin && !item.inLibrary ? [{
      label: "Recherche interactive",
      icon: <Telescope size={16} />,
      onClick: () => onInteractiveSearch(item),
      disabled: requesting,
    }] : []),
  ];

  return (
    <>
      <div className="group relative flex flex-col select-none">
        {/* Poster */}
        <div
          className="relative overflow-hidden rounded-xl aspect-[2/3] bg-slate-800 cursor-pointer"
          onClick={handlePosterClick}
        >
          {item.posterPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${TMDB_IMAGE_BASE}/w342${item.posterPath}`}
              alt={item.title}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-600">
              {type === "movie" ? <Film size={40} /> : <Tv size={40} />}
            </div>
          )}

          {/* In library badge */}
          {item.inLibrary && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <BookCheck size={8} /> Dispo
            </div>
          )}
          {!item.inLibrary && (item.radarrId || item.sonarrId) && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <Clock size={8} /> Attente
            </div>
          )}

          {/* Rating badge */}
          {item.rating > 0 && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-bold text-amber-400 backdrop-blur-sm">
              <Star size={7} className="fill-current" /> {item.rating.toFixed(1)}
            </div>
          )}

          {/* Added to watchlist indicator */}
          {AddedIcon && (
            <div className={`pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-black/70 p-1 ${STATUS_META[addedStatus!].textColor}`}>
              <AddedIcon size={8} />
            </div>
          )}

          {/* Desktop hover overlay */}
          <div className="absolute inset-0 hidden md:flex flex-col items-center justify-center gap-2 bg-black/88 backdrop-blur-sm opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            {/* Status buttons */}
            <div className="flex gap-0.5">
              {ALL_STATUSES.map((s) => {
                const meta = STATUS_META[s];
                const Icon = meta.icon;
                const active = addedStatus === s;
                return (
                  <button
                    key={s}
                    onClick={(e) => { e.stopPropagation(); addToWatchlist(s); }}
                    title={meta.label}
                    className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border transition-all duration-150 ${
                      active
                        ? `${meta.bgSolid} border-white/30 text-white scale-110 shadow-md`
                        : "border-white/15 bg-black/40 text-white/60 hover:border-white/30 hover:bg-white/15 hover:text-white hover:scale-105"
                    }`}
                  >
                    <Icon size={9} />
                  </button>
                );
              })}
            </div>

            {/* Actions row */}
            <div className="flex items-center gap-1">
              {libraryHref ? (
                <Link
                  href={libraryHref}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 rounded-lg bg-white/15 px-2 py-1 text-[10px] font-medium text-white hover:bg-white/25 transition-colors"
                >
                  <ExternalLink size={9} /> Voir la fiche
                </Link>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); onRequest(item); }}
                  disabled={requested || requesting}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
                    requested ? "bg-emerald-500/20 text-emerald-400" : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  <PlusCircle size={9} />
                  {requested ? "Demandé ✓" : requesting ? "…" : "Demander"}
                </button>
              )}
              {isAdmin && !item.inLibrary && (
                <button
                  onClick={(e) => { e.stopPropagation(); onInteractiveSearch(item); }}
                  disabled={requesting}
                  title="Recherche interactive"
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-lg bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40"
                >
                  <Telescope size={9} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Info strip */}
        <div className="mt-1.5 px-0.5">
          <p className="truncate text-[11px] font-medium text-slate-400 group-hover:text-slate-200 transition-colors">{item.title}</p>
          {item.year && <p className="text-[10px] text-slate-600">{item.year}</p>}
        </div>
      </div>

      {/* Mobile ActionSheet */}
      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={item.title}
        subtitle={[item.year, type === "movie" ? "Film" : "Série", item.rating > 0 ? `★ ${item.rating.toFixed(1)}` : null].filter(Boolean).join(" · ")}
        poster={item.posterPath ? `${TMDB_IMAGE_BASE}/w342${item.posterPath}` : null}
        actions={sheetActions}
      />
    </>
  );
}

function DiscoverGrid({ type }: { type: "movie" | "tv" }) {
  const endpoint = type === "movie" ? "/api/discover/movies" : "/api/discover/series";
  const { data, error, isLoading } = useSWR<DiscoverData>(endpoint, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300000,
  });

  const { role } = useRole();
  const isAdmin = role === "admin";
  const toast = useToast();

  const [genreFilter, setGenreFilter] = useState("");
  const [requesting, setRequesting] = useState<Set<number>>(new Set());
  const [requested, setRequested] = useState<Set<number>>(new Set());
  const [releaseModal, setReleaseModal] = useState<ReleaseModal | null>(null);
  const [addingSearch, setAddingSearch] = useState<number | null>(null);

  const filtered = (data?.items ?? []).filter(
    (item) => !genreFilter || item.genres.includes(genreFilter)
  );

  async function handleRequest(item: DiscoverItem) {
    setRequesting((prev) => new Set(prev).add(item.tmdbId));
    try {
      const res = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaType: type === "movie" ? "movie" : "tv",
          mediaId: item.tmdbId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Erreur");
      }
      setRequested((prev) => new Set(prev).add(item.tmdbId));
      fetch("/api/cache/invalidate", { method: "POST" }).catch(() => {});
      toast.success(`Demande envoyée pour « ${item.title} »`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de la demande");
    } finally {
      setRequesting((prev) => {
        const s = new Set(prev);
        s.delete(item.tmdbId);
        return s;
      });
    }
  }

  async function handleInteractiveSearch(item: DiscoverItem) {
    setAddingSearch(item.tmdbId);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: type === "movie" ? "movie" : "series", tmdbId: item.tmdbId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Erreur");

      if (type === "movie" && data.radarrId) {
        setReleaseModal({
          title: item.title,
          searchEndpoint: `/api/radarr/movies/${data.radarrId}/releases`,
          grabEndpoint: `/api/radarr/releases`,
        });
      } else if (type === "tv" && data.sonarrId) {
        setReleaseModal({
          title: item.title,
          searchEndpoint: `/api/sonarr/series/${data.sonarrId}/releases`,
          grabEndpoint: `/api/sonarr/series/${data.sonarrId}/releases/grab`,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible d'ajouter");
    } finally {
      setAddingSearch(null);
    }
  }

  if (isLoading) return <LoadingState />;
  if (error)
    return (
      <ErrorState
        message={
          error?.status === 503
            ? "TMDB_API_KEY non configurée — ajoutez-la dans les variables d'environnement."
            : error.message
        }
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
            Tous
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
        <p className="text-sm text-slate-500">Aucun résultat pour ce genre.</p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {filtered.map((item) => (
          <PosterCard
            key={item.tmdbId}
            item={item}
            type={type}
            onRequest={handleRequest}
            onInteractiveSearch={handleInteractiveSearch}
            isAdmin={isAdmin}
            requesting={requesting.has(item.tmdbId) || addingSearch === item.tmdbId}
            requested={requested.has(item.tmdbId)}
          />
        ))}
      </div>

      {releaseModal && (
        <ReleaseSearchModal
          title={releaseModal.title}
          searchEndpoint={releaseModal.searchEndpoint}
          grabEndpoint={releaseModal.grabEndpoint}
          onClose={() => setReleaseModal(null)}
        />
      )}
    </div>
  );
}

interface RecoData {
  items: (DiscoverItem & { type: "movie" | "tv" })[];
  hasHistory: boolean;
}

function RecommendationsGrid() {
  const { data, error, isLoading } = useSWR<RecoData>("/api/discover/recommendations", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 300000,
  });
  const { role } = useRole();
  const isAdmin = role === "admin";
  const toast = useToast();

  const [requesting, setRequesting] = useState<Set<number>>(new Set());
  const [requested, setRequested] = useState<Set<number>>(new Set());
  const [releaseModal, setReleaseModal] = useState<ReleaseModal | null>(null);
  const [addingSearch, setAddingSearch] = useState<number | null>(null);

  async function handleRequest(item: DiscoverItem) {
    setRequesting((prev) => new Set(prev).add(item.tmdbId));
    try {
      const res = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: item.type ?? "movie", mediaId: item.tmdbId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Erreur");
      setRequested((prev) => new Set(prev).add(item.tmdbId));
      fetch("/api/cache/invalidate", { method: "POST" }).catch(() => {});
      toast.success(`Demande envoyée pour « ${item.title} »`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de la demande");
    } finally {
      setRequesting((prev) => { const s = new Set(prev); s.delete(item.tmdbId); return s; });
    }
  }

  async function handleInteractiveSearch(item: DiscoverItem) {
    setAddingSearch(item.tmdbId);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: item.type === "tv" ? "series" : "movie", tmdbId: item.tmdbId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Erreur");
      if (item.type === "movie" && d.radarrId) {
        setReleaseModal({ title: item.title, searchEndpoint: `/api/radarr/movies/${d.radarrId}/releases`, grabEndpoint: `/api/radarr/movies/${d.radarrId}/releases/grab` });
      } else if (item.type === "tv" && d.sonarrId) {
        setReleaseModal({ title: item.title, searchEndpoint: `/api/sonarr/series/${d.sonarrId}/releases`, grabEndpoint: `/api/sonarr/releases` });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible d'ajouter");
    } finally {
      setAddingSearch(null);
    }
  }

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Impossible de charger les recommandations." />;
  if (!data?.hasHistory) {
    return (
      <div className="mt-12 flex flex-col items-center gap-3 text-center">
        <Sparkles size={36} className="text-slate-600" />
        <p className="text-sm text-slate-400">
          Regardez des films et séries sur Jellyfin pour obtenir des recommandations personnalisées.
        </p>
      </div>
    );
  }
  if (data.items.length === 0) {
    return <p className="text-sm text-slate-500">Tout ce que vous pourriez aimer est déjà dans votre bibliothèque !</p>;
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {data.items.map((item) => (
          <PosterCard
            key={`${item.type}-${item.tmdbId}`}
            item={item}
            type={item.type}
            onRequest={handleRequest}
            onInteractiveSearch={handleInteractiveSearch}
            isAdmin={isAdmin}
            requesting={requesting.has(item.tmdbId) || addingSearch === item.tmdbId}
            requested={requested.has(item.tmdbId)}
          />
        ))}
      </div>
      {releaseModal && (
        <ReleaseSearchModal
          title={releaseModal.title}
          searchEndpoint={releaseModal.searchEndpoint}
          grabEndpoint={releaseModal.grabEndpoint}
          onClose={() => setReleaseModal(null)}
        />
      )}
    </div>
  );
}

function SearchGrid({ query, type }: { query: string; type: "movie" | "tv" }) {
  const endpoint = query.length >= 2 ? `/api/discover/search?q=${encodeURIComponent(query)}&type=${type}` : null;
  const { data, isLoading } = useSWR<{ items: DiscoverItem[] }>(endpoint, fetcher, {
    dedupingInterval: 10000,
    keepPreviousData: true,
  });
  const { role } = useRole();
  const isAdmin = role === "admin";
  const toast = useToast();

  const [requesting, setRequesting] = useState<Set<number>>(new Set());
  const [requested, setRequested] = useState<Set<number>>(new Set());
  const [releaseModal, setReleaseModal] = useState<ReleaseModal | null>(null);
  const [addingSearch, setAddingSearch] = useState<number | null>(null);

  async function handleRequest(item: DiscoverItem) {
    setRequesting((prev) => new Set(prev).add(item.tmdbId));
    try {
      const res = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: type === "movie" ? "movie" : "tv", mediaId: item.tmdbId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Erreur");
      setRequested((prev) => new Set(prev).add(item.tmdbId));
      fetch("/api/cache/invalidate", { method: "POST" }).catch(() => {});
      toast.success(`Demande envoyée pour « ${item.title} »`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de la demande");
    } finally {
      setRequesting((prev) => { const s = new Set(prev); s.delete(item.tmdbId); return s; });
    }
  }

  async function handleInteractiveSearch(item: DiscoverItem) {
    setAddingSearch(item.tmdbId);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: type === "tv" ? "series" : "movie", tmdbId: item.tmdbId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Erreur");
      if (type === "movie" && d.radarrId) {
        setReleaseModal({ title: item.title, searchEndpoint: `/api/radarr/movies/${d.radarrId}/releases`, grabEndpoint: `/api/radarr/movies/${d.radarrId}/releases/grab` });
      } else if (type === "tv" && d.sonarrId) {
        setReleaseModal({ title: item.title, searchEndpoint: `/api/sonarr/series/${d.sonarrId}/releases`, grabEndpoint: `/api/sonarr/releases` });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible d'ajouter");
    } finally {
      setAddingSearch(null);
    }
  }

  if (query.length < 2) {
    return (
      <div className="mt-16 flex flex-col items-center gap-2 text-center text-slate-500">
        <SearchIcon size={32} className="text-slate-700" />
        <p className="text-sm">Tapez au moins 2 caractères pour rechercher</p>
      </div>
    );
  }

  if (isLoading) return <LoadingState />;
  if (!data?.items.length) return <p className="mt-8 text-center text-sm text-slate-500">Aucun résultat pour « {query} ».</p>;

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {data.items.map((item) => (
          <PosterCard
            key={item.tmdbId}
            item={item}
            type={type}
            onRequest={handleRequest}
            onInteractiveSearch={handleInteractiveSearch}
            isAdmin={isAdmin}
            requesting={requesting.has(item.tmdbId) || addingSearch === item.tmdbId}
            requested={requested.has(item.tmdbId)}
          />
        ))}
      </div>
      {releaseModal && (
        <ReleaseSearchModal
          title={releaseModal.title}
          searchEndpoint={releaseModal.searchEndpoint}
          grabEndpoint={releaseModal.grabEndpoint}
          onClose={() => setReleaseModal(null)}
        />
      )}
    </div>
  );
}

export default function DiscoverPage() {
  const [tab, setTab] = useState<"movie" | "tv" | "pour-vous">("movie");
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const { jfId } = useRole();
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce: update query 400ms after user stops typing
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim()), 400);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const isSearching = rawQuery.length > 0;
  const searchType = tab === "pour-vous" ? "movie" : tab;

  return (
    <div>
      <PageHeader
        title="Découverte"
        subtitle="Tendances TMDB cette semaine — demandez ou recherchez directement"
      />

      {/* Search bar */}
      <div className="relative mb-5">
        <SearchIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          ref={inputRef}
          type="text"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          placeholder="Rechercher dans la base TMDB…"
          className="w-full rounded-lg border border-white/10 bg-slate-800/60 py-2.5 pl-9 pr-9 text-sm text-white placeholder:text-slate-500 focus:border-accent-500/50 focus:outline-none focus:ring-1 focus:ring-accent-500/30"
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
            Pour vous
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
          Films
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
          Séries
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

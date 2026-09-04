"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/StateViews";
import type { RecommendationGroup, RecommendedMovie } from "@/app/api/recommendations/route";
import {
  Star, CirclePlus, ExternalLink, Eye, Heart, X, Clock, CircleCheck, BookCheck, Telescope,
} from "lucide-react";
import { Rail } from "@/components/Rail";
import { CarouselSkeleton } from "@/components/SkeletonCard";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import type { WatchlistStatus } from "@/lib/db";
import { useRole } from "@/lib/useRole";
import dynamic from "next/dynamic";
const ReleaseSearchModal = dynamic(() => import("@/components/ReleaseSearchModal").then((m) => m.ReleaseSearchModal), { ssr: false });
import { useToast } from "@/components/Toast";
import { apiAction } from "@/lib/apiAction";
import { useT } from "@/components/TranslationProvider";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useWatchlistStatusMap } from "@/lib/useWatchlistStatusMap";

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "favorite", "watched", "to_request", "abandoned"];

// ─── MovieCard ────────────────────────────────────────────────────────────────

function MovieCard({ m, watchlistStatus }: { m: RecommendedMovie; watchlistStatus?: WatchlistStatus | null }) {
  const router = useRouter();
  const { role } = useRole();
  const isAdmin = role === "admin";
  const toast = useToast();
  const t = useT();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const { addedStatus, addToWatchlist: addToWatchlistBase } = useAddToWatchlist(watchlistStatus ?? null);
  const [addingSearch, setAddingSearch] = useState(false);
  const [releaseModal, setReleaseModal] = useState<{ searchEndpoint: string; grabEndpoint: string } | null>(null);

  const STATUS_META: Record<WatchlistStatus, {
    label: string;
    icon: React.ElementType;
    textColor: string;
    bgSolid: string;
  }> = {
    to_watch:   { label: t('watchlist.statuses.toWatch'),   icon: Eye,          textColor: "text-sky-400",     bgSolid: "bg-sky-500" },
    to_request: { label: t('watchlist.statuses.toRequest'), icon: Clock,        textColor: "text-amber-400",   bgSolid: "bg-amber-500" },
    favorite:   { label: t('watchlist.statuses.favorites'), icon: Heart,        textColor: "text-rose-400",    bgSolid: "bg-rose-500" },
    watched:    { label: t('watchlist.statuses.watched'),   icon: CircleCheck, textColor: "text-emerald-400", bgSolid: "bg-emerald-500" },
    abandoned:  { label: t('watchlist.statuses.abandoned'), icon: X,            textColor: "text-slate-400",   bgSolid: "bg-slate-500" },
  };

  const libraryHref = m.radarrId ? `/radarr/${m.radarrId}` : null;

  async function doInteractiveSearch(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    setAddingSearch(true);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "movie", tmdbId: m.tmdbId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || t('common.unknown')); return; }
      if (data.radarrId) {
        setReleaseModal({ searchEndpoint: `/api/radarr/movies/${data.radarrId}/releases`, grabEndpoint: `/api/radarr/releases` });
      }
    } finally {
      setAddingSearch(false);
    }
  }

  function addToWatchlist(status: WatchlistStatus) {
    addToWatchlistBase(
      {
        tmdbId: m.tmdbId, mediaType: "movie", title: m.title,
        year: m.year, posterPath: m.posterPath, voteAverage: m.voteAverage,
      },
      status
    );
  }

  async function doRequest(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    if (requested || requesting) return;
    setRequesting(true);
    try {
      await apiAction("/api/jellyseerr/requests", {
        method: "POST",
        body: JSON.stringify({ mediaType: "movie", mediaId: m.tmdbId }),
      });
      setRequested(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'));
    } finally {
      setRequesting(false);
    }
  }

  function handlePosterClick() {
    if (window.matchMedia("(pointer: coarse)").matches) {
      setSheetOpen(true);
    } else if (libraryHref) {
      router.push(libraryHref);
    }
  }

  // ActionSheet actions for mobile
  // Même grammaire que la carte d'affiche partagée : ce qu'on vient faire d'abord, les statuts
  // de liste ensuite sous leur propre intitulé, et rien qui ne corresponde à l'état réel du film.
  const sheetActions: SheetAction[] = [
    ...(libraryHref
      ? [{ label: t('recommendations.viewSheet'), icon: <ExternalLink size={16} />, onClick: () => router.push(libraryHref) }]
      : []),
    ...(!m.inLibrary
      ? [{
          label: requested ? t('recommendations.requestSent') : requesting ? t('recommendations.requesting') : t('recommendations.request'),
          icon: <CirclePlus size={16} />,
          onClick: () => doRequest(),
          disabled: requested || requesting,
          variant: (requested ? "accent" : "default") as "accent" | "default",
        }]
      : []),
    ...(isAdmin && !m.inLibrary ? [{
      label: t('recommendations.interactiveSearch'),
      icon: <Telescope size={16} />,
      onClick: () => doInteractiveSearch(),
      disabled: addingSearch,
    }] : []),
    ...ALL_STATUSES.map((s) => {
      const meta = STATUS_META[s];
      const Icon = meta.icon;
      return {
        label: meta.label,
        icon: <Icon size={16} />,
        onClick: () => addToWatchlist(s),
        variant: (addedStatus === s ? "accent" : "default") as "accent" | "default",
        disabled: addedStatus === s,
        section: t('watchlist.pageTitle'),
      };
    }),
  ];

  const AddedIcon = addedStatus ? STATUS_META[addedStatus].icon : null;

  return (
    <>
      <div className="group relative shrink-0 w-32 select-none">
        {/* Poster */}
        <div
          className="relative overflow-hidden rounded-lg aspect-2/3 bg-slate-800 cursor-pointer"
          onClick={handlePosterClick}
        >
          {m.posterPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={m.posterPath}
              alt={m.title}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-600 text-xs text-center p-2">{m.title}</div>
          )}

          {/* In library badge */}
          {m.inLibrary && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <BookCheck size={8} /> {t('recommendations.available')}
            </div>
          )}

          {/* TMDB rating — always visible */}
          {m.voteAverage > 0 && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-bold text-amber-400 backdrop-blur-xs">
              <Star size={7} className="fill-current" /> {m.voteAverage.toFixed(1)}
            </div>
          )}

          {/* Watchlist status indicator after adding */}
          {AddedIcon && (
            <div className={`pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-black/70 p-1 ${STATUS_META[addedStatus!].textColor}`}>
              <AddedIcon size={8} />
            </div>
          )}

          {/* Desktop hover overlay */}
          <div className="absolute inset-0 hidden md:flex flex-col items-center justify-center gap-2 bg-black/75 backdrop-blur-xs opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            {/* 5 status buttons — fitted for w-32 cards */}
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
                    className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border transition duration-150 ${
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

            {/* Fiche or Request + admin search */}
            <div className="flex items-center gap-1">
              {libraryHref ? (
                <Link
                  href={libraryHref}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 rounded-lg bg-white/15 px-2 py-1 text-[10px] font-medium text-white hover:bg-white/25 transition-colors"
                >
                  <ExternalLink size={9} /> {t('recommendations.viewSheet')}
                </Link>
              ) : m.inLibrary ? null : (
                <button
                  onClick={(e) => doRequest(e)}
                  disabled={requested || requesting}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
                    requested ? "bg-emerald-500/20 text-emerald-400" : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  <CirclePlus size={9} />
                  {requested ? t('recommendations.requested') : requesting ? "…" : t('recommendations.request')}
                </button>
              )}
              {isAdmin && !m.inLibrary && (
                <button
                  onClick={(e) => doInteractiveSearch(e)}
                  disabled={addingSearch}
                  title={t('recommendations.interactiveSearch')}
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-lg bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40"
                >
                  <Telescope size={9} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Title + year */}
        <p className="mt-1.5 truncate text-[11px] font-medium text-slate-400 group-hover:text-slate-200 transition-colors">
          {m.title}
        </p>
        {m.year && <p className="text-[10px] text-slate-600">{m.year}</p>}
      </div>

      {/* Mobile ActionSheet */}
      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={m.title}
        subtitle={[m.year, t('common.film'), m.voteAverage > 0 ? `★ ${m.voteAverage.toFixed(1)}` : null].filter(Boolean).join(" · ")}
        poster={m.posterPath}
        actions={sheetActions}
      />

      {/* Interactive search modal */}
      {releaseModal && (
        <ReleaseSearchModal
          title={m.title}
          searchEndpoint={releaseModal.searchEndpoint}
          grabEndpoint={releaseModal.grabEndpoint}
          onClose={() => setReleaseModal(null)}
        />
      )}
    </>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function RecommendationRow({ group, statusMap }: { group: RecommendationGroup; statusMap: Record<string, WatchlistStatus | null> }) {
  const t = useT();
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-slate-500">{t('recommendations.becauseYouWatched')}</span>
        <span className="text-sm font-semibold text-white">{group.seedTitle}</span>
      </div>
      <Rail>
        {group.movies.map((m) => <MovieCard key={m.tmdbId} m={m} watchlistStatus={statusMap[`movie:${m.tmdbId}`]} />)}
      </Rail>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecommendationsPage() {
  const { data, isLoading } = useSWR<{ groups: RecommendationGroup[] }>(
    "/api/recommendations",
    fetcher,
    { revalidateOnFocus: false }
  );
  const t = useT();

  const groups = data?.groups ?? [];
  const allMovies = groups.flatMap((g) => g.movies);
  const statusMap = useWatchlistStatusMap(allMovies.map((m) => ({ mediaType: "movie", tmdbId: m.tmdbId })));

  return (
    <div>
      <PageHeader title={t('recommendations.pageTitle')} subtitle={t('recommendations.subtitle')} />

      {isLoading && (
        <div className="space-y-8">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="mb-3 flex items-center gap-2">
                <div className="h-3 w-32 animate-pulse rounded-sm bg-slate-800" />
                <div className="h-4 w-40 animate-pulse rounded-sm bg-slate-700" />
              </div>
              <Rail>
                <CarouselSkeleton count={5} width="w-32" />
              </Rail>
            </div>
          ))}
        </div>
      )}

      {!isLoading && groups.length === 0 && (
        <EmptyState label={t('recommendations.empty')} />
      )}

      {groups.length > 0 && (
        <div className="space-y-8">
          {groups.map((g) => <RecommendationRow key={g.seedTmdbId} group={g} statusMap={statusMap} />)}
        </div>
      )}
    </div>
  );
}

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
  Star, PlusCircle, ExternalLink, Eye, Heart, X, Clock, CheckCircle2, BookCheck,
} from "lucide-react";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { CarouselSkeleton } from "@/components/SkeletonCard";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import type { WatchlistStatus } from "@/lib/db";

// ─── Status meta (same palette as watchlist) ──────────────────────────────────

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

// ─── MovieCard ────────────────────────────────────────────────────────────────

function MovieCard({ m }: { m: RecommendedMovie }) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [addedStatus, setAddedStatus] = useState<WatchlistStatus | null>(null);

  const libraryHref = m.radarrId ? `/radarr/${m.radarrId}` : null;

  async function addToWatchlist(status: WatchlistStatus) {
    setAddedStatus(status);
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdbId: m.tmdbId, mediaType: "movie", title: m.title,
        year: m.year, posterPath: m.posterPath, voteAverage: m.voteAverage, status,
      }),
    });
  }

  async function doRequest(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    if (requested || requesting) return;
    setRequesting(true);
    await fetch("/api/jellyseerr/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: "movie", mediaId: m.tmdbId }),
    });
    setRequested(true);
    setRequesting(false);
  }

  function handlePosterClick() {
    if (window.matchMedia("(pointer: coarse)").matches) {
      setSheetOpen(true);
    } else if (libraryHref) {
      router.push(libraryHref);
    }
  }

  // ActionSheet actions for mobile
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
          onClick: () => doRequest(),
          disabled: requested || requesting,
          variant: requested ? "accent" as const : "default" as const,
        }]
    ),
  ];

  const AddedIcon = addedStatus ? STATUS_META[addedStatus].icon : null;

  return (
    <>
      <div className="group relative flex-shrink-0 w-32 select-none">
        {/* Poster */}
        <div
          className="relative overflow-hidden rounded-lg aspect-[2/3] bg-slate-800 cursor-pointer"
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
              <BookCheck size={8} /> Dispo
            </div>
          )}

          {/* TMDB rating — always visible */}
          {m.voteAverage > 0 && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-bold text-amber-400 backdrop-blur-sm">
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
          <div className="absolute inset-0 hidden md:flex flex-col items-center justify-center gap-2 bg-black/78 backdrop-blur-[1.5px] opacity-0 transition-opacity duration-200 group-hover:opacity-100">
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

            {/* Fiche or Request */}
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
                onClick={(e) => doRequest(e)}
                disabled={requested || requesting}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
                  requested ? "bg-emerald-500/20 text-emerald-400" : "bg-white/10 text-white hover:bg-white/20"
                }`}
              >
                <PlusCircle size={9} />
                {requested ? "Demandé ✓" : requesting ? "…" : "Demander"}
              </button>
            )}
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
        subtitle={[m.year, "Film", m.voteAverage > 0 ? `★ ${m.voteAverage.toFixed(1)}` : null].filter(Boolean).join(" · ")}
        poster={m.posterPath}
        actions={sheetActions}
      />
    </>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function RecommendationRow({ group }: { group: RecommendationGroup }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-slate-500">Parce que vous avez regardé</span>
        <span className="text-sm font-semibold text-white">{group.seedTitle}</span>
      </div>
      <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory" style={{ scrollbarWidth: "none" }}>
        {group.movies.map((m) => <MovieCard key={m.tmdbId} m={m} />)}
      </HorizontalCarousel>
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

  const groups = data?.groups ?? [];

  return (
    <div>
      <PageHeader title="Recommandations" subtitle="Basées sur votre historique Jellyfin" />

      {isLoading && (
        <div className="space-y-8">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="mb-3 flex items-center gap-2">
                <div className="h-3 w-32 animate-pulse rounded bg-slate-800" />
                <div className="h-4 w-40 animate-pulse rounded bg-slate-700" />
              </div>
              <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: "none" }}>
                <CarouselSkeleton count={5} width="w-32" />
              </HorizontalCarousel>
            </div>
          ))}
        </div>
      )}

      {!isLoading && groups.length === 0 && (
        <EmptyState label="Aucune recommandation — regardez quelques films sur Jellyfin pour en générer." />
      )}

      {groups.length > 0 && (
        <div className="space-y-8">
          {groups.map((g) => <RecommendationRow key={g.seedTmdbId} group={g} />)}
        </div>
      )}
    </div>
  );
}

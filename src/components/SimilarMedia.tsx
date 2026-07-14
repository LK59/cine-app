"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import { useRole } from "@/lib/useRole";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import { ReleaseSearchModal } from "@/components/ReleaseSearchModal";
import {
  Star, BookCheck, CirclePlus, ExternalLink,
  Eye, Heart, X, Clock, CircleCheck, Telescope,
} from "lucide-react";
import type { SimilarMovie } from "@/app/api/radarr/movies/[id]/similar/route";
import type { SimilarSeries } from "@/app/api/sonarr/series/[id]/similar/route";
import type { WatchlistStatus } from "@/lib/db";

type Item = (SimilarMovie & { sonarrId?: never }) | (SimilarSeries & { radarrId?: never });

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "favorite", "watched", "to_request", "abandoned"];

function SimilarCard({ item, type }: { item: Item; type: "movie" | "series" }) {
  const router = useRouter();
  const { role } = useRole();
  const isAdmin = role === "admin";
  const toast = useToast();
  const t = useT();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [addedStatus, setAddedStatus] = useState<WatchlistStatus | null>(null);
  const [addingSearch, setAddingSearch] = useState(false);
  const [releaseModal, setReleaseModal] = useState<{ searchEndpoint: string; grabEndpoint: string } | null>(null);

  const STATUS_META: Record<WatchlistStatus, { label: string; icon: React.ElementType; textColor: string; bgSolid: string }> = {
    to_watch:   { label: t("watchlist.statuses.toWatch"),   icon: Eye,          textColor: "text-sky-400",     bgSolid: "bg-sky-500" },
    to_request: { label: t("watchlist.statuses.toRequest"), icon: Clock,        textColor: "text-amber-400",   bgSolid: "bg-amber-500" },
    favorite:   { label: t("watchlist.statuses.favorites"), icon: Heart,        textColor: "text-rose-400",    bgSolid: "bg-rose-500" },
    watched:    { label: t("watchlist.statuses.watched"),   icon: CircleCheck, textColor: "text-emerald-400", bgSolid: "bg-emerald-500" },
    abandoned:  { label: t("watchlist.statuses.abandoned"), icon: X,            textColor: "text-slate-400",   bgSolid: "bg-slate-500" },
  };

  const libraryHref = type === "movie"
    ? (item.radarrId ? `/radarr/${item.radarrId}` : null)
    : (item.sonarrId ? `/sonarr/${item.sonarrId}` : null);

  async function addToWatchlist(status: WatchlistStatus) {
    setAddedStatus(status);
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdbId: item.tmdbId,
        mediaType: type,
        title: item.title,
        year: item.year,
        posterPath: item.posterPath,
        voteAverage: item.voteAverage,
        status,
      }),
    });
  }

  async function doRequest(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    if (requested || requesting) return;
    setRequesting(true);
    const res = await fetch("/api/jellyseerr/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: type, mediaId: item.tmdbId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || t("common.unknown"));
    } else {
      setRequested(true);
    }
    setRequesting(false);
  }

  async function doInteractiveSearch(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    if (type !== "movie") return;
    setAddingSearch(true);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "movie", tmdbId: item.tmdbId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || t("common.unknown")); return; }
      if (data.radarrId) {
        setReleaseModal({ searchEndpoint: `/api/radarr/movies/${data.radarrId}/releases`, grabEndpoint: `/api/radarr/releases` });
      }
    } finally {
      setAddingSearch(false);
    }
  }

  function handlePosterClick() {
    if (window.matchMedia("(pointer: coarse)").matches) {
      setSheetOpen(true);
    } else if (libraryHref) {
      router.push(libraryHref);
    }
  }

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
      ? [{ label: t("recommendations.viewSheet"), icon: <ExternalLink size={16} />, onClick: () => router.push(libraryHref) }]
      : [{
          label: requested ? t("recommendations.requestSent") : requesting ? t("recommendations.requesting") : t("recommendations.request"),
          icon: <CirclePlus size={16} />,
          onClick: () => doRequest(),
          disabled: requested || requesting,
          variant: requested ? "accent" as const : "default" as const,
        }]
    ),
    ...(isAdmin && !item.inLibrary && type === "movie" ? [{
      label: t("recommendations.interactiveSearch"),
      icon: <Telescope size={16} />,
      onClick: () => doInteractiveSearch(),
      disabled: addingSearch,
    }] : []),
  ];

  const AddedIcon = addedStatus ? STATUS_META[addedStatus].icon : null;

  return (
    <>
      <div className="group relative shrink-0 w-24 select-none touch-manipulation">
        <div
          className="relative aspect-2/3 overflow-hidden rounded-lg bg-slate-800 cursor-pointer"
          onClick={handlePosterClick}
        >
          {item.posterPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.posterPath}
              alt={item.title}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-600 text-xs text-center p-1">{item.title}</div>
          )}

          {item.inLibrary && (
            <div className="pointer-events-none absolute right-1 top-1 flex items-center gap-0.5 rounded-full bg-emerald-500/90 px-1 py-0.5 text-[8px] font-bold text-white">
              <BookCheck size={7} /> {t("recommendations.available")}
            </div>
          )}

          {item.voteAverage > 0 && (
            <div className="pointer-events-none absolute bottom-1 left-1 flex items-center gap-0.5 rounded-full bg-black/70 px-1 py-0.5 text-[8px] font-bold text-amber-400 backdrop-blur-xs">
              <Star size={6} className="fill-current" /> {item.voteAverage.toFixed(1)}
            </div>
          )}

          {AddedIcon && (
            <div className={`pointer-events-none absolute bottom-1 right-1 rounded-full bg-black/70 p-0.5 ${STATUS_META[addedStatus!].textColor}`}>
              <AddedIcon size={7} />
            </div>
          )}

          {/* Desktop hover overlay */}
          <div className="absolute inset-0 hidden md:flex flex-col items-center justify-center gap-1.5 bg-black/75 backdrop-blur-xs opacity-0 transition-opacity duration-200 group-hover:opacity-100">
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
                    className={`flex h-[20px] w-[20px] items-center justify-center rounded-full border transition-all duration-150 ${
                      active
                        ? `${meta.bgSolid} border-white/30 text-white scale-110 shadow-md`
                        : "border-white/15 bg-black/40 text-white/60 hover:border-white/30 hover:bg-white/15 hover:text-white hover:scale-105"
                    }`}
                  >
                    <Icon size={8} />
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1">
              {libraryHref ? (
                <Link
                  href={libraryHref}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-0.5 rounded-lg bg-white/15 px-1.5 py-0.5 text-[9px] font-medium text-white hover:bg-white/25 transition-colors"
                >
                  <ExternalLink size={8} /> {t("recommendations.viewSheet")}
                </Link>
              ) : (
                <button
                  onClick={(e) => doRequest(e)}
                  disabled={requested || requesting}
                  className={`flex items-center gap-0.5 rounded-lg px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                    requested ? "bg-emerald-500/20 text-emerald-400" : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  <CirclePlus size={8} />
                  {requested ? t("recommendations.requested") : requesting ? "…" : t("recommendations.request")}
                </button>
              )}
              {isAdmin && !item.inLibrary && type === "movie" && (
                <button
                  onClick={(e) => doInteractiveSearch(e)}
                  disabled={addingSearch}
                  title={t("recommendations.interactiveSearch")}
                  className="flex h-[20px] w-[20px] items-center justify-center rounded-lg bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40"
                >
                  <Telescope size={8} />
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="mt-1 truncate text-[11px] font-medium text-slate-400 transition-colors group-hover:text-slate-200">{item.title}</p>
        {item.year && <p className="text-[10px] text-slate-600">{item.year}</p>}
      </div>

      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={item.title}
        subtitle={[item.year, type === "movie" ? t("common.film") : t("common.series"), item.voteAverage > 0 ? `★ ${item.voteAverage.toFixed(1)}` : null].filter(Boolean).join(" · ")}
        poster={item.posterPath}
        actions={sheetActions}
      />

      {releaseModal && (
        <ReleaseSearchModal
          title={item.title}
          searchEndpoint={releaseModal.searchEndpoint}
          grabEndpoint={releaseModal.grabEndpoint}
          onClose={() => setReleaseModal(null)}
        />
      )}
    </>
  );
}

interface Props {
  apiUrl: string;
  type: "movie" | "series";
}

export function SimilarMedia({ apiUrl, type }: Props) {
  const { data } = useSWR<{ items: Item[] }>(apiUrl, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    dedupingInterval: 3_600_000,
  });
  const t = useT();

  const items = data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="mb-3 text-sm font-semibold text-white">{t("similar.title")}</h3>
      <HorizontalCarousel className="scrollbar-thin flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
        {items.map((item) => (
          <div key={item.tmdbId} className="snap-start">
            <SimilarCard item={item} type={type} />
          </div>
        ))}
      </HorizontalCarousel>
    </div>
  );
}

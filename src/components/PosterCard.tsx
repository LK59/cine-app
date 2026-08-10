"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Star, BookCheck, CirclePlus, ExternalLink, Loader2, Clock,
  Eye, Heart, X, CircleCheck, Telescope, Film, Tv,
} from "lucide-react";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import { ReleaseSearchModal } from "@/components/ReleaseSearchModal";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useRole } from "@/lib/useRole";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import type { WatchlistStatus } from "@/lib/db";

export interface PosterCardItem {
  tmdbId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  rating: number;
  inLibrary: boolean;
  libraryHref: string | null;
  /** Already requested/added but not yet available in the library. */
  pending?: boolean;
  /** Current watchlist status, if already on the list — from a bulk-status lookup. */
  watchlistStatus?: WatchlistStatus | null;
}

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "favorite", "watched", "to_request", "abandoned"];

interface Props {
  item: PosterCardItem;
  mediaType: "movie" | "series";
  size?: "grid" | "carousel";
  /** Called after a successful admin interactive-search add (item just entered the library pipeline). */
  onAdded?: (tmdbId: number) => void;
}

export function PosterCard({ item, mediaType, size = "grid", onAdded }: Props) {
  const router = useRouter();
  const { role } = useRole();
  const isAdmin = role === "admin";
  const toast = useToast();
  const t = useT();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const { addedStatus, addToWatchlist: addToWatchlistBase } = useAddToWatchlist(item.watchlistStatus ?? null);
  const [addingSearch, setAddingSearch] = useState(false);
  const [releaseModal, setReleaseModal] = useState<{ searchEndpoint: string; grabEndpoint: string } | null>(null);

  const STATUS_META: Record<WatchlistStatus, { label: string; icon: React.ElementType; textColor: string; bgSolid: string }> = {
    to_watch:   { label: t("watchlist.statuses.toWatch"),   icon: Eye,          textColor: "text-sky-400",     bgSolid: "bg-sky-500" },
    to_request: { label: t("watchlist.statuses.toRequest"), icon: Clock,        textColor: "text-amber-400",   bgSolid: "bg-amber-500" },
    favorite:   { label: t("watchlist.statuses.favorites"), icon: Heart,        textColor: "text-rose-400",    bgSolid: "bg-rose-500" },
    watched:    { label: t("watchlist.statuses.watched"),   icon: CircleCheck, textColor: "text-emerald-400", bgSolid: "bg-emerald-500" },
    abandoned:  { label: t("watchlist.statuses.abandoned"), icon: X,            textColor: "text-slate-400",   bgSolid: "bg-slate-500" },
  };

  function addToWatchlist(status: WatchlistStatus) {
    addToWatchlistBase(
      {
        tmdbId: item.tmdbId,
        mediaType,
        title: item.title,
        year: item.year,
        posterPath: item.posterUrl,
        voteAverage: item.rating,
      },
      status
    );
  }

  async function doRequest(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    if (requested || requesting) return;
    setRequesting(true);
    const res = await fetch("/api/jellyseerr/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: mediaType === "series" ? "tv" : "movie", mediaId: item.tmdbId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || t("common.unknown"));
    } else {
      setRequested(true);
      fetch("/api/cache/invalidate", { method: "POST" }).catch(() => {});
    }
    setRequesting(false);
  }

  async function doInteractiveSearch(e?: React.MouseEvent) {
    e?.preventDefault(); e?.stopPropagation();
    setAddingSearch(true);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: mediaType, tmdbId: item.tmdbId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || t("common.unknown")); return; }
      if (mediaType === "movie" && data.radarrId) {
        onAdded?.(item.tmdbId);
        setReleaseModal({ searchEndpoint: `/api/radarr/movies/${data.radarrId}/releases`, grabEndpoint: `/api/radarr/releases` });
      } else if (mediaType === "series" && data.sonarrId) {
        onAdded?.(item.tmdbId);
        setReleaseModal({ searchEndpoint: `/api/sonarr/series/${data.sonarrId}/releases`, grabEndpoint: `/api/sonarr/releases` });
      }
    } finally {
      setAddingSearch(false);
    }
  }

  function handlePosterClick() {
    if (window.matchMedia("(pointer: coarse)").matches) {
      setSheetOpen(true);
    } else if (item.libraryHref) {
      router.push(item.libraryHref);
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
    ...(item.libraryHref
      ? [{ label: t("recommendations.viewSheet"), icon: <ExternalLink size={16} />, onClick: () => router.push(item.libraryHref!) }]
      : [{
          label: requested ? t("recommendations.requestSent") : requesting ? t("recommendations.requesting") : t("recommendations.request"),
          icon: <CirclePlus size={16} />,
          onClick: () => doRequest(),
          disabled: requested || requesting,
          variant: requested ? "accent" as const : "default" as const,
        }]
    ),
    ...(isAdmin && !item.inLibrary ? [{
      label: t("recommendations.interactiveSearch"),
      icon: <Telescope size={16} />,
      onClick: () => doInteractiveSearch(),
      disabled: addingSearch,
    }] : []),
  ];

  const AddedIcon = addedStatus ? STATUS_META[addedStatus].icon : null;
  const carousel = size === "carousel";
  const btnSize = carousel ? 20 : 22;
  const iconSize = carousel ? 8 : 9;

  return (
    <>
      <div className={`group relative flex flex-col select-none touch-manipulation ${carousel ? "w-24 shrink-0" : ""}`}>
        <div
          className={`relative aspect-2/3 overflow-hidden bg-slate-800 cursor-pointer ${carousel ? "rounded-lg" : "rounded-xl"}`}
          onClick={handlePosterClick}
        >
          {item.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.posterUrl}
              alt={item.title}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-600">
              {mediaType === "movie" ? <Film size={carousel ? 28 : 40} /> : <Tv size={carousel ? 28 : 40} />}
            </div>
          )}

          {item.inLibrary && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <BookCheck size={8} /> {t("recommendations.available")}
            </div>
          )}
          {!item.inLibrary && item.pending && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <Clock size={8} /> {t("discover.pending")}
            </div>
          )}

          {item.rating > 0 && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-bold text-amber-400 backdrop-blur-xs">
              <Star size={7} className="fill-current" /> {item.rating.toFixed(1)}
            </div>
          )}

          {AddedIcon && (
            <div className={`pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-black/70 p-1 ${STATUS_META[addedStatus!].textColor}`}>
              <AddedIcon size={8} />
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
                    style={{ height: btnSize, width: btnSize }}
                    className={`flex items-center justify-center rounded-full border transition duration-150 ${
                      active
                        ? `${meta.bgSolid} border-white/30 text-white scale-110 shadow-md`
                        : "border-white/15 bg-black/40 text-white/60 hover:border-white/30 hover:bg-white/15 hover:text-white hover:scale-105"
                    }`}
                  >
                    <Icon size={iconSize} />
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1">
              {item.libraryHref ? (
                <Link
                  href={item.libraryHref}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 rounded-lg bg-white/15 px-2 py-1 text-[10px] font-medium text-white hover:bg-white/25 transition-colors"
                >
                  <ExternalLink size={9} /> {t("recommendations.viewSheet")}
                </Link>
              ) : (
                <button
                  onClick={(e) => doRequest(e)}
                  disabled={requested || requesting}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
                    requested ? "bg-emerald-500/20 text-emerald-400" : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  <CirclePlus size={9} />
                  {requested ? t("recommendations.requested") : requesting ? "…" : t("recommendations.request")}
                </button>
              )}
              {isAdmin && !item.inLibrary && (
                <button
                  onClick={(e) => doInteractiveSearch(e)}
                  disabled={addingSearch}
                  title={t("recommendations.interactiveSearch")}
                  style={{ height: btnSize, width: btnSize }}
                  className="flex items-center justify-center rounded-lg bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40"
                >
                  {addingSearch ? <Loader2 size={iconSize} className="animate-spin" /> : <Telescope size={iconSize} />}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className={carousel ? "mt-1" : "mt-1.5 px-0.5"}>
          <p className="truncate text-[11px] font-medium text-slate-400 group-hover:text-slate-200 transition-colors">{item.title}</p>
          {item.year && <p className="text-[10px] text-slate-600">{item.year}</p>}
        </div>
      </div>

      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={item.title}
        subtitle={[item.year, mediaType === "movie" ? t("common.film") : t("common.series"), item.rating > 0 ? `★ ${item.rating.toFixed(1)}` : null].filter(Boolean).join(" · ")}
        poster={item.posterUrl}
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

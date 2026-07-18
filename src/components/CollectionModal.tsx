"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Modal } from "@/components/Modal";
import {
  Film, BookCheck, Star, Library, Loader2,
  CirclePlus, ExternalLink, Eye, Heart, X, Clock, CircleCheck, Telescope,
} from "lucide-react";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import { ReleaseSearchModal } from "@/components/ReleaseSearchModal";
import { useAddToWatchlist } from "@/lib/useAddToWatchlist";
import { useRole } from "@/lib/useRole";
import type { WatchlistStatus } from "@/lib/db";

interface CollectionPart {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  voteAverage: number;
  inLibrary: boolean;
  libraryHref: string | null;
}

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "favorite", "watched", "to_request", "abandoned"];

function PartCard({ part, onAdded }: { part: CollectionPart; onAdded: (id: number) => void }) {
  const router = useRouter();
  const { role } = useRole();
  const isAdmin = role === "admin";
  const toast = useToast();
  const t = useT();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const { addedStatus, addToWatchlist: addToWatchlistBase } = useAddToWatchlist();
  const [addingSearch, setAddingSearch] = useState(false);
  const [releaseModal, setReleaseModal] = useState<{ searchEndpoint: string; grabEndpoint: string } | null>(null);

  const STATUS_META: Record<WatchlistStatus, { label: string; icon: React.ElementType; textColor: string; bgSolid: string }> = {
    to_watch:   { label: t("watchlist.statuses.toWatch"),   icon: Eye,          textColor: "text-sky-400",     bgSolid: "bg-sky-500" },
    to_request: { label: t("watchlist.statuses.toRequest"), icon: Clock,        textColor: "text-amber-400",   bgSolid: "bg-amber-500" },
    favorite:   { label: t("watchlist.statuses.favorites"), icon: Heart,        textColor: "text-rose-400",    bgSolid: "bg-rose-500" },
    watched:    { label: t("watchlist.statuses.watched"),   icon: CircleCheck, textColor: "text-emerald-400", bgSolid: "bg-emerald-500" },
    abandoned:  { label: t("watchlist.statuses.abandoned"), icon: X,            textColor: "text-slate-400",   bgSolid: "bg-slate-500" },
  };

  const posterUrl = part.posterPath ? `${TMDB_IMAGE_BASE}/w185${part.posterPath}` : null;

  function addToWatchlist(status: WatchlistStatus) {
    addToWatchlistBase(
      {
        tmdbId: part.tmdbId,
        mediaType: "movie",
        title: part.title,
        year: part.year,
        posterPath: part.posterPath,
        voteAverage: part.voteAverage,
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
      body: JSON.stringify({ mediaType: "movie", mediaId: part.tmdbId }),
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
    setAddingSearch(true);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "movie", tmdbId: part.tmdbId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || t("common.unknown")); return; }
      if (data.radarrId) {
        onAdded(part.tmdbId);
        setReleaseModal({ searchEndpoint: `/api/radarr/movies/${data.radarrId}/releases`, grabEndpoint: `/api/radarr/releases` });
      }
    } finally {
      setAddingSearch(false);
    }
  }

  function handlePosterClick() {
    if (window.matchMedia("(pointer: coarse)").matches) {
      setSheetOpen(true);
    } else if (part.libraryHref) {
      router.push(part.libraryHref);
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
    ...(part.libraryHref
      ? [{ label: t("recommendations.viewSheet"), icon: <ExternalLink size={16} />, onClick: () => router.push(part.libraryHref!) }]
      : [{
          label: requested ? t("recommendations.requestSent") : requesting ? t("recommendations.requesting") : t("recommendations.request"),
          icon: <CirclePlus size={16} />,
          onClick: () => doRequest(),
          disabled: requested || requesting,
          variant: requested ? "accent" as const : "default" as const,
        }]
    ),
    ...(isAdmin && !part.inLibrary ? [{
      label: t("recommendations.interactiveSearch"),
      icon: <Telescope size={16} />,
      onClick: () => doInteractiveSearch(),
      disabled: addingSearch,
    }] : []),
  ];

  const AddedIcon = addedStatus ? STATUS_META[addedStatus].icon : null;

  return (
    <>
      <div className="group relative flex flex-col select-none touch-manipulation">
        <div
          className="relative aspect-2/3 overflow-hidden rounded-lg bg-slate-800 cursor-pointer"
          onClick={handlePosterClick}
        >
          {posterUrl ? (
            <Image
              src={posterUrl}
              alt={part.title}
              fill
              sizes="120px"
              className="object-cover transition-transform duration-300 group-hover:scale-[1.04]"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-600">
              <Film size={28} />
            </div>
          )}

          {part.inLibrary && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded-sm bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-xs">
              <BookCheck size={9} />
            </div>
          )}

          {part.voteAverage > 0 && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 backdrop-blur-xs">
              <Star size={9} className="fill-amber-400" />
              {part.voteAverage.toFixed(1)}
            </div>
          )}

          {AddedIcon && (
            <div className={`pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-black/70 p-0.5 ${STATUS_META[addedStatus!].textColor}`}>
              <AddedIcon size={9} />
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
                    className={`flex h-[20px] w-[20px] items-center justify-center rounded-full border transition duration-150 ${
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
              {part.libraryHref ? (
                <Link
                  href={part.libraryHref}
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
              {isAdmin && !part.inLibrary && (
                <button
                  onClick={(e) => doInteractiveSearch(e)}
                  disabled={addingSearch}
                  title={t("recommendations.interactiveSearch")}
                  className="flex h-[20px] w-[20px] items-center justify-center rounded-lg bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40"
                >
                  {addingSearch ? <Loader2 size={8} className="animate-spin" /> : <Telescope size={8} />}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-1 flex flex-col gap-0.5 px-0.5">
          <p className="line-clamp-2 text-xs font-medium leading-snug text-white">{part.title}</p>
          {part.year && <p className="text-[11px] text-slate-500">{part.year}</p>}
        </div>
      </div>

      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={part.title}
        subtitle={[part.year, t("common.film"), part.voteAverage > 0 ? `★ ${part.voteAverage.toFixed(1)}` : null].filter(Boolean).join(" · ")}
        poster={posterUrl}
        actions={sheetActions}
      />

      {releaseModal && (
        <ReleaseSearchModal
          title={part.title}
          searchEndpoint={releaseModal.searchEndpoint}
          grabEndpoint={releaseModal.grabEndpoint}
          onClose={() => setReleaseModal(null)}
        />
      )}
    </>
  );
}

export function CollectionModal({
  collectionId,
  collectionName,
  onClose,
}: {
  collectionId: number;
  collectionName: string;
  onClose: () => void;
}) {
  const t = useT();
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());

  const { data, isLoading } = useSWR<{ name: string; overview: string; parts: CollectionPart[] }>(
    `/api/tmdb/collection/${collectionId}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const parts = data?.parts ?? [];
  const inLibrary = parts.filter((p) => p.inLibrary || addedIds.has(p.tmdbId));
  const missing = parts.filter((p) => !p.inLibrary && !addedIds.has(p.tmdbId));

  return (
    <Modal title={collectionName} onClose={onClose} wide>
      {isLoading && (
        <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          {t('collection.loading')}
        </div>
      )}

      {!isLoading && data?.overview && (
        <p className="mb-5 text-sm text-slate-400 leading-relaxed">{data.overview}</p>
      )}

      {inLibrary.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
            <Library size={13} />
            {t('collection.inLibrary', { n: inLibrary.length, total: parts.length })}
          </h3>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {inLibrary.map((p) => (
              <PartCard key={p.tmdbId} part={p} onAdded={(id) => setAddedIds((s) => new Set(s).add(id))} />
            ))}
          </div>
        </div>
      )}

      {missing.length > 0 && (
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <Film size={13} />
            {t('collection.toAdd', { n: missing.length })}
          </h3>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {missing.map((p) => (
              <PartCard key={p.tmdbId} part={p} onAdded={(id) => setAddedIds((s) => new Set(s).add(id))} />
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

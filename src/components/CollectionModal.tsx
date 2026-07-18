"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Modal } from "@/components/Modal";
import { Film, Library, Loader2, ListPlus } from "lucide-react";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import { PosterCard, type PosterCardItem } from "@/components/PosterCard";

interface CollectionPart {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  voteAverage: number;
  inLibrary: boolean;
  libraryHref: string | null;
}

function toPosterCardItem(part: CollectionPart): PosterCardItem {
  return {
    tmdbId: part.tmdbId,
    title: part.title,
    year: part.year,
    posterUrl: part.posterPath ? `${TMDB_IMAGE_BASE}/w185${part.posterPath}` : null,
    rating: part.voteAverage,
    inLibrary: part.inLibrary,
    libraryHref: part.libraryHref,
  };
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
  const toast = useToast();
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
  const [bulkAdding, setBulkAdding] = useState(false);

  const { data, isLoading } = useSWR<{ name: string; overview: string; parts: CollectionPart[] }>(
    `/api/tmdb/collection/${collectionId}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const parts = data?.parts ?? [];
  const inLibrary = parts.filter((p) => p.inLibrary || addedIds.has(p.tmdbId));
  const missing = parts.filter((p) => !p.inLibrary && !addedIds.has(p.tmdbId));

  async function addAllToWatchlist() {
    if (bulkAdding || missing.length === 0) return;
    setBulkAdding(true);
    try {
      await Promise.all(
        missing.map((p) =>
          fetch("/api/watchlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tmdbId: p.tmdbId,
              mediaType: "movie",
              title: p.title,
              year: p.year,
              posterPath: p.posterPath,
              voteAverage: p.voteAverage,
              status: "to_watch",
            }),
          })
        )
      );
      toast.success(t("collection.bulkAddedToast", { n: missing.length }));
    } catch {
      toast.error(t("watchlist.addFailed"));
    } finally {
      setBulkAdding(false);
    }
  }

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
              <PosterCard
                key={p.tmdbId}
                item={toPosterCardItem(p)}
                mediaType="movie"
              />
            ))}
          </div>
        </div>
      )}

      {missing.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <Film size={13} />
              {t('collection.toAdd', { n: missing.length })}
            </h3>
            <button
              onClick={addAllToWatchlist}
              disabled={bulkAdding}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-accent-400 transition-colors disabled:opacity-50"
            >
              {bulkAdding ? <Loader2 size={12} className="animate-spin" /> : <ListPlus size={12} />}
              {t('collection.addAllToWatchlist')}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {missing.map((p) => (
              <PosterCard
                key={p.tmdbId}
                item={toPosterCardItem(p)}
                mediaType="movie"
                onAdded={(id) => setAddedIds((s) => new Set(s).add(id))}
              />
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

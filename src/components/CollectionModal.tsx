"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Modal } from "@/components/Modal";
import { Film, BookCheck, Plus, Loader2, Star, Library } from "lucide-react";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";

interface CollectionPart {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  voteAverage: number;
  inLibrary: boolean;
  libraryHref: string | null;
}

function PartCard({ part, onAdded }: { part: CollectionPart; onAdded: (id: number) => void }) {
  const toast = useToast();
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const isInLib = part.inLibrary || added;

  async function handleAdd(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setAdding(true);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: part.tmdbId, type: "movie" }),
      });
      if (!res.ok) throw new Error();
      setAdded(true);
      onAdded(part.tmdbId);
      toast.success(t('modals.actor.addedToast', { title: part.title }));
    } catch {
      toast.error(t('modals.actor.addErrorToast'));
    } finally {
      setAdding(false);
    }
  }

  const inner = (
    <div className="card flex flex-col overflow-hidden transition-all hover:ring-1 hover:ring-accent-500/40">
      <div className="relative aspect-[2/3] bg-slate-800">
        {part.posterPath ? (
          <Image
            src={`${TMDB_IMAGE_BASE}/w185${part.posterPath}`}
            alt={part.title}
            fill
            sizes="120px"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-600">
            <Film size={28} />
          </div>
        )}
        {isInLib && (
          <div className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
            <BookCheck size={9} />
          </div>
        )}
        {part.voteAverage > 0 && (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 backdrop-blur-sm">
            <Star size={9} className="fill-amber-400" />
            {part.voteAverage.toFixed(1)}
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2">
        <p className="line-clamp-2 text-xs font-medium leading-snug text-white">{part.title}</p>
        {part.year && <p className="text-[11px] text-slate-500">{part.year}</p>}
        {!isInLib && (
          <button
            onClick={handleAdd}
            disabled={adding}
            className="mt-auto flex items-center justify-center gap-1 rounded bg-accent-600/20 py-1 text-[11px] text-accent-400 transition-colors hover:bg-accent-600/30 disabled:opacity-50"
          >
            {adding ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            {adding ? t('common.adding') : t('common.add')}
          </button>
        )}
      </div>
    </div>
  );

  return isInLib && part.libraryHref ? (
    <Link href={part.libraryHref} onClick={(e) => e.stopPropagation()}>
      {inner}
    </Link>
  ) : (
    inner
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

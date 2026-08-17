"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Modal } from "@/components/Modal";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { ArrowDown, ArrowUp, Download, AlertTriangle } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";

interface Release {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  protocol: string;
  seeders?: number;
  leechers?: number;
  age: number;
  quality: { quality: { name: string } };
  rejected: boolean;
  rejections: string[];
}

import { fmtSize as formatBytes } from "@/lib/format";

export function ReleaseSearchModal({
  title,
  searchEndpoint,
  grabEndpoint,
  mediaId,
  onClose,
}: {
  title: string;
  searchEndpoint: string;
  grabEndpoint: string;
  /** Radarr movie id — only passed by the discover/add-triggered flow, where the movie was just
   *  added unmonitored (see /api/discover/add) specifically so it doesn't get auto-searched
   *  before anything's actually been picked here. Grabbing a release flips it back to monitored
   *  server-side (see /api/radarr/releases) so it behaves normally afterwards; other callers
   *  (an existing, already-monitored library item's own manual search) simply omit this. */
  mediaId?: number;
  onClose: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [grabbing, setGrabbing] = useState<string | null>(null);
  const [grabbed, setGrabbed] = useState<Set<string>>(new Set());
  const [grabError, setGrabError] = useState<string | null>(null);
  const { data, error, isLoading } = useSWR<Release[]>(searchEndpoint, fetcher, {
    revalidateOnFocus: false,
  });

  async function grab(release: Release) {
    setGrabbing(release.guid);
    setGrabError(null);
    try {
      const res = await fetch(grabEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guid: release.guid, indexerId: release.indexerId, ...(mediaId ? { mediaId } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('modals.releases.downloadError'));
      }
      setGrabbed((prev) => new Set(prev).add(release.guid));
      toast.success(t('modals.releases.downloadSuccess', { quality: release.quality?.quality?.name ?? '?' }));
    } catch (err) {
      setGrabError(err instanceof Error ? err.message : t('modals.releases.unknown'));
      toast.error(t('modals.releases.downloadError'));
    } finally {
      setGrabbing(null);
    }
  }

  const sorted = data
    ? [...data].sort((a, b) => Number(a.rejected) - Number(b.rejected) || (b.seeders ?? 0) - (a.seeders ?? 0))
    : [];

  return (
    <Modal title={title} onClose={onClose} wide>
      {isLoading && <LoadingState label={t('modals.releases.searching')} />}
      {error && <ErrorState message={error.message || t('modals.releases.error')} />}
      {grabError && <ErrorState message={grabError} />}
      {data && sorted.length === 0 && <EmptyState label={t('modals.releases.noResults')} />}

      {sorted.length > 0 && (
        <div className="scrollbar-thin max-h-[60vh] space-y-2 overflow-y-auto">
          {sorted.map((release) => (
            <div
              key={release.guid}
              className={`rounded-lg border p-3 ${
                release.rejected
                  ? "border-red-500/20 bg-red-500/5"
                  : "border-white/5 bg-white/5"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white" title={release.title}>
                    {release.title}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span className="badge bg-accent-600/15 text-accent-400">
                      {release.quality?.quality?.name ?? "?"}
                    </span>
                    <span>{formatBytes(release.size)}</span>
                    <span>{release.indexer}</span>
                    {release.protocol === "torrent" && (
                      <>
                        <span className="flex items-center gap-1 text-emerald-400">
                          <ArrowDown size={12} /> {release.seeders ?? 0}
                        </span>
                        <span className="flex items-center gap-1 text-slate-500">
                          <ArrowUp size={12} /> {release.leechers ?? 0}
                        </span>
                      </>
                    )}
                    <span>{Math.round(release.age)}j</span>
                  </div>
                  {release.rejected && release.rejections.length > 0 && (
                    <p className="mt-1.5 flex items-start gap-1 text-xs text-red-400">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      {release.rejections.join(", ")}
                    </p>
                  )}
                </div>
                <button
                  className="btn-primary shrink-0"
                  disabled={grabbing === release.guid || grabbed.has(release.guid)}
                  onClick={() => grab(release)}
                >
                  <Download size={14} />
                  {grabbed.has(release.guid)
                    ? t('modals.releases.sent')
                    : grabbing === release.guid
                      ? t('modals.releases.sending')
                      : t('modals.releases.download')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

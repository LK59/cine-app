"use client";

import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { Pause, Play, Trash2, ArrowDown, ArrowUp } from "lucide-react";
import type { QbTorrent } from "@/lib/clients/qbittorrent";
import { useRole } from "@/lib/useRole";
import { INTERVALS } from "@/lib/refresh-intervals";
import { useEffect, useMemo, useState } from "react";

import { fmtSize as formatBytes } from "@/lib/format";

const PAGE_SIZE = 20;

function isPaused(state: string): boolean {
  return /^(paused|stopped)/i.test(state);
}

// Active downloads first, then everything else (seeding/uploading), paused last.
function statePriority(state: string): number {
  if (isPaused(state)) return 2;
  if (/^(downloading|metadl|stalleddl|queueddl|checkingdl|forceddl|allocating)/i.test(state)) return 0;
  return 1;
}

function sortTorrents(torrents: QbTorrent[]): QbTorrent[] {
  return [...torrents].sort((a, b) => {
    const diff = statePriority(a.state) - statePriority(b.state);
    if (diff !== 0) return diff;
    return b.dlspeed - a.dlspeed;
  });
}

export default function QbittorrentPage() {
  const { mutate } = useSWRConfig();
  const { isGuest } = useRole();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const { data: torrents, error, isLoading } = useSWR<QbTorrent[]>(
    "/api/qbittorrent/torrents",
    fetcher,
    { refreshInterval: INTERVALS.TORRENTS }
  );
  const { data: transfer } = useSWR<{ dl_info_speed: number; up_info_speed: number }>(
    "/api/qbittorrent/transfer",
    fetcher,
    { refreshInterval: INTERVALS.TORRENTS }
  );

  const sortedTorrents = useMemo(() => sortTorrents(torrents ?? []), [torrents]);
  const visibleTorrents = sortedTorrents.slice(0, visibleCount);
  const hasMore = visibleCount < sortedTorrents.length;

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [torrents?.length]);

  async function action(hash: string, action: "pause" | "resume") {
    await fetch(`/api/qbittorrent/torrents/${hash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    mutate("/api/qbittorrent/torrents");
  }

  async function remove(hash: string) {
    if (!confirm("Supprimer ce torrent (fichiers conservés) ?")) return;
    await fetch(`/api/qbittorrent/torrents/${hash}?deleteFiles=false`, { method: "DELETE" });
    mutate("/api/qbittorrent/torrents");
  }

  return (
    <div>
      <PageHeader
        title="Téléchargements"
        subtitle={
          transfer
            ? `↓ ${formatBytes(transfer.dl_info_speed)}/s · ↑ ${formatBytes(transfer.up_info_speed)}/s`
            : undefined
        }
      />

      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message || "Impossible de contacter qBittorrent."} />}
      {torrents && torrents.length === 0 && <EmptyState label="Aucun torrent actif." />}

      {torrents && torrents.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between gap-3 text-xs text-slate-500">
            <span>
              {visibleTorrents.length} affichés sur {sortedTorrents.length}
            </span>
            {hasMore && <span>Chargement par lots de {PAGE_SIZE}</span>}
          </div>

          <div className="card divide-y divide-slate-800">
          {visibleTorrents.map((t) => (
            <div key={t.hash} className="flex items-center gap-4 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{t.name}</p>
                <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                  <span>{formatBytes(t.size)}</span>
                  <span className="flex items-center gap-1 text-emerald-400">
                    <ArrowDown size={12} /> {formatBytes(t.dlspeed)}/s
                  </span>
                  <span className="flex items-center gap-1 text-accent-400">
                    <ArrowUp size={12} /> {formatBytes(t.upspeed)}/s
                  </span>
                  <span className="capitalize">{t.state}</span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800">
                  <div
                    className="h-1.5 rounded-full bg-accent-500"
                    style={{ width: `${Math.round(t.progress * 100)}%` }}
                  />
                </div>
              </div>
              {!isGuest && (
                <div className="flex items-center gap-1">
                  {isPaused(t.state) ? (
                    <button onClick={() => action(t.hash, "resume")} className="btn-ghost px-2">
                      <Play size={14} />
                    </button>
                  ) : (
                    <button onClick={() => action(t.hash, "pause")} className="btn-ghost px-2">
                      <Pause size={14} />
                    </button>
                  )}
                  <button onClick={() => remove(t.hash)} className="btn-danger px-2">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
          </div>

          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, sortedTorrents.length))}
                className="btn-ghost w-full justify-center sm:w-auto"
              >
                Charger 20 de plus
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

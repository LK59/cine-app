"use client";

import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { Pause, Play, Trash2, ArrowDown, ArrowUp, Search } from "lucide-react";
import type { QbTorrent } from "@/lib/clients/qbittorrent";
import { useRole } from "@/lib/useRole";
import { useT } from "@/components/TranslationProvider";
import { INTERVALS } from "@/lib/refresh-intervals";
import { useEffect, useMemo, useState } from "react";
import { TorrentDetailModal } from "@/components/TorrentDetailModal";

import { fmtSize as formatBytes, fmtEta } from "@/lib/format";

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
    const pa = statePriority(a.state);
    const pb = statePriority(b.state);
    if (pa !== pb) return pa - pb;
    // Downloading: fastest download first. Everything else (seeding/paused):
    // most active upload first, to spot the busiest seeds at a glance.
    return pa === 0 ? b.dlspeed - a.dlspeed : b.upspeed - a.upspeed;
  });
}

export default function QbittorrentPage() {
  const { mutate } = useSWRConfig();
  const { isGuest } = useRole();
  const t = useT();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [query, setQuery] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
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

  const filteredTorrents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return torrents ?? [];
    return (torrents ?? []).filter((t) => t.name.toLowerCase().includes(q));
  }, [torrents, query]);
  const sortedTorrents = useMemo(() => sortTorrents(filteredTorrents), [filteredTorrents]);
  const visibleTorrents = sortedTorrents.slice(0, visibleCount);
  const hasMore = visibleCount < sortedTorrents.length;
  const selectedTorrent = torrents?.find((t) => t.hash === selectedHash) ?? null;

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, torrents?.length]);

  async function action(hash: string, action: "pause" | "resume") {
    await fetch(`/api/qbittorrent/torrents/${hash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    mutate("/api/qbittorrent/torrents");
  }

  async function remove(hash: string) {
    if (!confirm(t('qbittorrent.confirmDelete'))) return;
    await fetch(`/api/qbittorrent/torrents/${hash}?deleteFiles=false`, { method: "DELETE" });
    mutate("/api/qbittorrent/torrents");
  }

  async function removeWithFiles(hash: string, deleteFiles: boolean) {
    await fetch(`/api/qbittorrent/torrents/${hash}?deleteFiles=${deleteFiles}`, { method: "DELETE" });
    setSelectedHash(null);
    mutate("/api/qbittorrent/torrents");
  }

  return (
    <div>
      <PageHeader
        title={t('qbittorrent.pageTitle')}
        subtitle={
          transfer
            ? `↓ ${formatBytes(transfer.dl_info_speed)}/s · ↑ ${formatBytes(transfer.up_info_speed)}/s`
            : undefined
        }
      />

      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message || t('qbittorrent.serviceDown')} />}
      {torrents && torrents.length === 0 && <EmptyState label={t('qbittorrent.noActiveTorrents')} />}

      {torrents && torrents.length > 0 && (
        <div>
          <div className="relative mb-3">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('qbittorrent.searchPlaceholder')}
              className="input w-full pl-9"
            />
          </div>

          {sortedTorrents.length === 0 ? (
            <EmptyState label={t('qbittorrent.noMatches')} />
          ) : (
          <>
          <div className="mb-3 flex items-center justify-between gap-3 text-xs text-slate-500">
            <span>
              {t('qbittorrent.showing', { n: String(visibleTorrents.length), total: String(sortedTorrents.length) })}
            </span>
            {hasMore && <span>{t('qbittorrent.batchLoad', { n: String(PAGE_SIZE) })}</span>}
          </div>

          <div className="card divide-y divide-slate-800">
          {visibleTorrents.map((torrent, i) => {
            const prev = visibleTorrents[i - 1];
            const curPriority = statePriority(torrent.state);
            const prevPriority = prev ? statePriority(prev.state) : -1;
            const sectionLabel =
              curPriority !== prevPriority
                ? curPriority === 0 ? t('qbittorrent.sectionActive')
                  : curPriority === 1 ? t('qbittorrent.sectionSeed')
                  : t('qbittorrent.sectionPaused')
                : null;
            return (
            <div key={torrent.hash}>
              {sectionLabel && (
                <div className={`flex items-center gap-2 px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider ${
                  curPriority === 0 ? "text-accent-400" : curPriority === 1 ? "text-emerald-400" : "text-slate-600"
                }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${curPriority === 0 ? "bg-accent-400 animate-pulse" : curPriority === 1 ? "bg-emerald-500" : "bg-slate-700"}`} />
                  {sectionLabel}
                </div>
              )}
            <div
              className="flex cursor-pointer items-center gap-4 p-3 hover:bg-white/5"
              onClick={() => setSelectedHash(torrent.hash)}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{torrent.name}</p>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                  <span>{formatBytes(torrent.size)}</span>
                  <span className="flex items-center gap-1 text-emerald-400">
                    <ArrowDown size={12} /> {formatBytes(torrent.dlspeed)}/s
                  </span>
                  <span className="flex items-center gap-1 text-accent-400">
                    <ArrowUp size={12} /> {formatBytes(torrent.upspeed)}/s
                  </span>
                  {curPriority === 0 && <span>{t('qbittorrent.eta')} {fmtEta(torrent.eta)}</span>}
                  <span className="capitalize">{torrent.state}</span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800">
                  <div
                    className="h-1.5 rounded-full bg-accent-500"
                    style={{ width: `${Math.round(torrent.progress * 100)}%` }}
                  />
                </div>
              </div>
              {!isGuest && (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {isPaused(torrent.state) ? (
                    <button onClick={() => action(torrent.hash, "resume")} className="btn-ghost px-2">
                      <Play size={14} />
                    </button>
                  ) : (
                    <button onClick={() => action(torrent.hash, "pause")} className="btn-ghost px-2">
                      <Pause size={14} />
                    </button>
                  )}
                  <button onClick={() => remove(torrent.hash)} className="btn-danger px-2">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
            </div>
            );
          })}
          </div>

          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, sortedTorrents.length))}
                className="btn-ghost w-full justify-center sm:w-auto"
              >
                {t('qbittorrent.loadMore')}
              </button>
            </div>
          )}
          </>
          )}
        </div>
      )}

      {selectedTorrent && (
        <TorrentDetailModal
          torrent={selectedTorrent}
          isGuest={isGuest}
          onClose={() => setSelectedHash(null)}
          onAction={action}
          onRemove={removeWithFiles}
        />
      )}
    </div>
  );
}

"use client";

import { ServiceNotConfigured } from "@/components/ServiceNotConfigured";
import { useConfiguredServices } from "@/lib/useConfiguredServices";

import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { Pause, Play, Trash2, ArrowDown, ArrowUp, Search, ChevronDown } from "lucide-react";
import type { QbTorrent } from "@/lib/clients/qbittorrent";
import { useRole } from "@/lib/useRole";
import { useT } from "@/components/TranslationProvider";
import { INTERVALS } from "@/lib/refresh-intervals";
import { useEffect, useMemo, useState } from "react";
import { TorrentDetailModal } from "@/components/TorrentDetailModal";

import { fmtSize as formatBytes, fmtEta } from "@/lib/format";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";

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

function trackerHost(tracker: string): string {
  try {
    return new URL(tracker).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

type StatusFilter = "all" | "downloading" | "seeding" | "paused";

function matchesStatus(state: string, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  const p = statePriority(state);
  if (filter === "downloading") return p === 0;
  if (filter === "seeding") return p === 1;
  return p === 2;
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
  // Un service absent est une configuration, pas une panne : la page le dit et donne la
  // marche à suivre, au lieu de partir chercher un serveur qui n'existe pas.
  const notConfigured = !useConfiguredServices().isConfigured("qbittorrent");
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { isReadOnly } = useRole();
  const t = useT();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [trackerFilter, setTrackerFilter] = useState("all");
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

  const categories = useMemo(
    () => Array.from(new Set((torrents ?? []).map((t) => t.category).filter(Boolean))).sort(),
    [torrents]
  );
  const trackers = useMemo(
    () => Array.from(new Set((torrents ?? []).map((t) => trackerHost(t.tracker)).filter(Boolean))).sort(),
    [torrents]
  );

  const filteredTorrents = useMemo(() => {
    const q = query.trim().toLowerCase();
  return (torrents ?? []).filter((t) => {
      if (q && !t.name.toLowerCase().includes(q)) return false;
      if (!matchesStatus(t.state, statusFilter)) return false;
      if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
      if (trackerFilter !== "all" && trackerHost(t.tracker) !== trackerFilter) return false;
      return true;
    });
  }, [torrents, query, statusFilter, categoryFilter, trackerFilter]);
  const sortedTorrents = useMemo(() => sortTorrents(filteredTorrents), [filteredTorrents]);
  const visibleTorrents = sortedTorrents.slice(0, visibleCount);
  const hasMore = visibleCount < sortedTorrents.length;
  const selectedTorrent = torrents?.find((t) => t.hash === selectedHash) ?? null;

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, statusFilter, categoryFilter, trackerFilter, torrents?.length]);

  /**
   * Toutes les actions de cette page passent par ici, et disent quand elles échouent.
   *
   * Elles ne le disaient pas : `await fetch(...)` puis rafraîchissement de la liste, ce qui rend
   * une requête refusée indiscernable d'une requête acceptée — rien ne bouge, rien n'est dit.
   * C'est ainsi que le bouton pause est resté mort à travers une montée de version de
   * qBittorrent sans que personne puisse savoir pourquoi.
   */
  async function run(work: Promise<unknown>, done?: string) {
    try {
      await work;
      if (done) toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'));
    } finally {
      mutate("/api/qbittorrent/torrents");
    }
  }

  /**
   * Le bouton bascule sous le doigt, qBittorrent confirme ensuite.
   *
   * L'état est écrit sur place *avant* l'appel, parce que qBittorrent met un instant à refléter
   * l'ordre qu'on vient de lui donner : une relecture immédiate renvoie encore l'ancien état et
   * ferait clignoter le bouton. On lui laisse donc une seconde et demie avant de relire, et on
   * remet l'état d'origine tout de suite s'il a refusé.
   */
  async function action(hash: string, action: "pause" | "resume") {
    const before = torrents?.find((x) => x.hash === hash)?.state ?? "";
    const seeding = /up$/i.test(before) || /^(uploading|stalledUP)/i.test(before);
    const after =
      action === "pause" ? (seeding ? "pausedUP" : "pausedDL") : seeding ? "uploading" : "downloading";

    const write = (state: string) =>
      mutate(
        "/api/qbittorrent/torrents",
        (current?: QbTorrent[]) => current?.map((x) => (x.hash === hash ? { ...x, state } : x)),
        { revalidate: false }
      );

    write(after);
    try {
      await apiAction(`/api/qbittorrent/torrents/${hash}`, { method: "POST", body: JSON.stringify({ action }) });
      toast.success(action === "pause" ? t('qbittorrent.paused') : t('qbittorrent.resumed'));
      setTimeout(() => mutate("/api/qbittorrent/torrents"), 1500);
    } catch (error) {
      write(before);
      toast.error(error instanceof Error ? error.message : t('common.error'));
      mutate("/api/qbittorrent/torrents");
    }
  }

  async function remove(hash: string) {
    if (!confirm(t('qbittorrent.confirmDelete'))) return;
    await run(apiAction(`/api/qbittorrent/torrents/${hash}?deleteFiles=false`, { method: "DELETE" }));
  }

  async function removeWithFiles(hash: string, deleteFiles: boolean) {
    await run(apiAction(`/api/qbittorrent/torrents/${hash}?deleteFiles=${deleteFiles}`, { method: "DELETE" }));
    setSelectedHash(null);
  }

  if (notConfigured) return <ServiceNotConfigured service="qbittorrent" />;

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

          <div className="scrollbar-none mb-3 flex gap-2 overflow-x-auto pb-0.5 [touch-action:pan-x] sm:flex-wrap sm:overflow-visible">
            <div className="relative shrink-0">
              <select
                className="input appearance-none pr-7 text-sm"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              >
                <option value="all">{t('qbittorrent.filterStatusAll')}</option>
                <option value="downloading">{t('qbittorrent.sectionActive')}</option>
                <option value="seeding">{t('qbittorrent.sectionSeed')}</option>
                <option value="paused">{t('qbittorrent.sectionPaused')}</option>
              </select>
              <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>

            {categories.length > 0 && (
              <div className="relative shrink-0">
                <select
                  className="input appearance-none pr-7 text-sm"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                >
                  <option value="all">{t('qbittorrent.filterCategoryAll')}</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            )}

            {trackers.length > 0 && (
              <div className="relative shrink-0">
                <select
                  className="input appearance-none pr-7 text-sm"
                  value={trackerFilter}
                  onChange={(e) => setTrackerFilter(e.target.value)}
                >
                  <option value="all">{t('qbittorrent.filterTrackerAll')}</option>
                  {trackers.map((tr) => <option key={tr} value={tr}>{tr}</option>)}
                </select>
                <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
            )}
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
              {!isReadOnly && (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {isPaused(torrent.state) ? (
                    <button onClick={() => action(torrent.hash, "resume")} className="btn-ghost px-2" title={t('qbittorrent.actionResume')} aria-label={t('qbittorrent.actionResume')}>
                      <Play size={14} />
                    </button>
                  ) : (
                    <button onClick={() => action(torrent.hash, "pause")} className="btn-ghost px-2" title={t('qbittorrent.actionPause')} aria-label={t('qbittorrent.actionPause')}>
                      <Pause size={14} />
                    </button>
                  )}
                  <button onClick={() => remove(torrent.hash)} className="btn-danger px-2" title={t('qbittorrent.actionDelete')} aria-label={t('qbittorrent.actionDelete')}>
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
          isReadOnly={isReadOnly}
          onClose={() => setSelectedHash(null)}
          onAction={action}
          onRemove={removeWithFiles}
        />
      )}
    </div>
  );
}

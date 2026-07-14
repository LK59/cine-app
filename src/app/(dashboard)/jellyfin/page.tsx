"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { Film, Tv, Clapperboard, Zap, Cpu, RefreshCw, BarChart2, Clock, Play, type LucideIcon } from "lucide-react";
import type { JellyfinSession } from "@/lib/clients/jellyfin";
import { useRole } from "@/lib/useRole";
import { INTERVALS } from "@/lib/refresh-intervals";
import { useToast } from "@/components/Toast";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { CarouselSkeleton } from "@/components/SkeletonCard";
import { useT } from "@/components/TranslationProvider";

function formatBitrate(bps?: number): string {
  if (!bps) return "?";
  return `${(bps / 1_000_000).toFixed(1)} Mb/s`;
}

function formatTicks(ticks?: number): string {
  if (!ticks || ticks < 0) return "0:00";
  const totalSeconds = Math.floor(ticks / 10_000_000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDuration(ticks: number): string {
  const totalMinutes = Math.floor(ticks / 600_000_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h${m > 0 ? ` ${m}min` : ""}`;
}

import { relDate } from "@/lib/format";

interface PlaybackData {
  counts: { moviesPlayed: number; episodesPlayed: number };
  recentMovies: {
    id: string; name: string; lastPlayed: string | null;
    playCount: number; imageTag: string | null; runtimeTicks: number;
  }[];
  recentEpisodes: {
    id: string; name: string; seriesName: string | null; season: number | null;
    episode: number | null; lastPlayed: string | null; imageTag: string | null; runtimeTicks: number;
  }[];
}

export default function JellyfinPage() {
  const { isGuest, jfId, jfUser } = useRole();
  const toast = useToast();
  const t = useT();
  const { mutate } = useSWRConfig();
  const [tab, setTab] = useState<"live" | "stats">("live");
  const [refreshing, setRefreshing] = useState(false);

  const { data: sessions, error, isLoading } = useSWR<JellyfinSession[]>(
    "/api/jellyfin/sessions",
    fetcher,
    { refreshInterval: INTERVALS.SESSIONS }
  );
  const { data: library } = useSWR<{
    counts: { MovieCount: number; SeriesCount: number; EpisodeCount: number };
    systemInfo: { ServerName: string; Version: string };
  }>("/api/jellyfin/library", fetcher);
  const { data: playback, isLoading: statsLoading } = useSWR<PlaybackData>(
    tab === "stats" && jfId ? "/api/jellyfin/playback" : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const playing = (sessions?.filter((s) => s.NowPlayingItem) ?? []).filter((s) =>
    isGuest && jfUser ? s.UserName?.toLowerCase() === jfUser.toLowerCase() : true
  );

  async function refreshLibrary() {
    setRefreshing(true);
    try {
      await fetch("/api/jellyfin/library/refresh", { method: "POST" });
      mutate("/api/jellyfin/library");
      toast.success(t('jellyfin.refreshSuccess'));
    } catch {
      toast.error(t('jellyfin.refreshError'));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Jellyfin"
        subtitle={library ? `${library.systemInfo.ServerName} · v${library.systemInfo.Version}` : undefined}
        action={
          !isGuest && (
            <button onClick={refreshLibrary} disabled={refreshing} className="btn-ghost px-3 py-1.5 text-xs">
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? t('jellyfin.refreshing') : t('jellyfin.refreshButton')}
            </button>
          )
        }
      />

      {library && (
        <div className="mb-6 grid grid-cols-3 gap-4">
          <StatCard icon={Film} label={t('jellyfin.movies')} value={library.counts.MovieCount} />
          <StatCard icon={Tv} label={t('jellyfin.series')} value={library.counts.SeriesCount} />
          <StatCard icon={Clapperboard} label={t('jellyfin.episodes')} value={library.counts.EpisodeCount} />
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex gap-2 border-b border-white/10 pb-0">
        <button
          onClick={() => setTab("live")}
          className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
            tab === "live"
              ? "border-b-2 border-accent-500 text-accent-400"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Play size={14} />
          {t('jellyfin.live')}
          {playing.length > 0 && (
            <span className="ml-1 rounded-full bg-accent-600/30 px-1.5 py-0.5 text-[10px] text-accent-400">
              {playing.length}
            </span>
          )}
        </button>
        {jfId && (
          <button
            onClick={() => setTab("stats")}
            className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === "stats"
                ? "border-b-2 border-accent-500 text-accent-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <BarChart2 size={14} />
            {t('jellyfin.myStats')}
          </button>
        )}
      </div>

      {/* Live tab */}
      {tab === "live" && (
        <>
          {isLoading && <LoadingState />}
          {error && <ErrorState message={t('jellyfin.serviceDown')} />}
          {sessions && playing.length === 0 && <EmptyState label={t('jellyfin.noActivePlays')} />}
          {playing.length > 0 && (
            <div className="card divide-y divide-slate-800">
              {playing.map((s) => {
                const progress =
                  s.PlayState?.PositionTicks && s.NowPlayingItem?.RunTimeTicks
                    ? (s.PlayState.PositionTicks / s.NowPlayingItem.RunTimeTicks) * 100
                    : 0;
                const isTranscoding = s.PlayState?.PlayMethod === "Transcode";
                return (
                  <div key={s.Id} className="p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-white">{s.NowPlayingItem?.Name}</span>
                      <span className="text-slate-500">{s.UserName} · {s.DeviceName}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <span className={`badge ${isTranscoding ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400"}`}>
                        {isTranscoding ? <Cpu size={12} /> : <Zap size={12} />}
                        {isTranscoding ? t('jellyfin.transcoding') : s.PlayState?.PlayMethod ?? t('jellyfin.directPlay')}
                      </span>
                      {isTranscoding && s.TranscodingInfo && (
                        <>
                          <span className="text-slate-500">{formatBitrate(s.TranscodingInfo.Bitrate)}</span>
                          {s.TranscodingInfo.VideoCodec && (
                            <span className="text-slate-500">
                              {s.TranscodingInfo.VideoCodec.toUpperCase()}
                              {s.TranscodingInfo.AudioCodec ? ` / ${s.TranscodingInfo.AudioCodec.toUpperCase()}` : ""}
                            </span>
                          )}
                          {s.TranscodingInfo.TranscodeReasons && s.TranscodingInfo.TranscodeReasons.length > 0 && (
                            <span className="text-slate-600" title={s.TranscodingInfo.TranscodeReasons.join(", ")}>
                              ({s.TranscodingInfo.TranscodeReasons[0]})
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800">
                      <div className="h-1.5 rounded-full bg-accent-500" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                      <span>{formatTicks(s.PlayState?.PositionTicks)}</span>
                      <span>{formatTicks(s.NowPlayingItem?.RunTimeTicks)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Stats tab */}
      {tab === "stats" && (
        <>
          {statsLoading && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                {[0, 1].map(i => <div key={i} className="card h-24 animate-pulse bg-slate-800/50" />)}
              </div>
              <div>
                <div className="mb-3 h-4 w-40 rounded-sm bg-slate-800 animate-pulse" />
                <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
                  <CarouselSkeleton count={5} width="w-32" />
                </HorizontalCarousel>
              </div>
            </div>
          )}
          {!statsLoading && playback && (
            <div className="space-y-6">
              {/* Aggregate counts */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-2">
                <div className="card flex items-center gap-4 p-4">
                  <div className="rounded-xl bg-accent-600/15 p-3 text-accent-400">
                    <Film size={24} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-white">{playback.counts.moviesPlayed}</p>
                    <p className="text-xs text-slate-500">{t('jellyfin.moviesWatched')}</p>
                  </div>
                </div>
                <div className="card flex items-center gap-4 p-4">
                  <div className="rounded-xl bg-sky-600/15 p-3 text-sky-400">
                    <Tv size={24} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-white">{playback.counts.episodesPlayed}</p>
                    <p className="text-xs text-slate-500">{t('jellyfin.episodesWatched')}</p>
                  </div>
                </div>
              </div>

              {/* Recent movies */}
              {playback.recentMovies.length > 0 && (
                <div>
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                    <Film size={14} className="text-accent-400" />
                    {t('jellyfin.recentMovies')}
                  </h3>
                  <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin snap-x snap-mandatory">
                    {playback.recentMovies.map((m) => (
                      <a
                        key={m.id}
                        href={`/api/jellyfin/redirect?itemId=${m.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="card w-32 shrink-0 overflow-hidden hover:ring-1 hover:ring-accent-500/40 touch-manipulation"
                      >
                        <div className="aspect-2/3 bg-slate-800">
                          {m.imageTag ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`/api/jellyfin/image?itemId=${m.id}&tag=${m.imageTag}`}
                              alt={m.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-slate-600">
                              <Film size={24} />
                            </div>
                          )}
                        </div>
                        <div className="p-2">
                          <p className="truncate text-xs font-medium text-white">{m.name}</p>
                          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                            <Clock size={9} />
                            {relDate(m.lastPlayed)}
                          </div>
                          {m.runtimeTicks > 0 && (
                            <p className="text-[11px] text-slate-600">{formatDuration(m.runtimeTicks)}</p>
                          )}
                          {m.playCount > 1 && (
                            <span className="mt-1 inline-block rounded-sm bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">
                              {m.playCount}×
                            </span>
                          )}
                        </div>
                      </a>
                    ))}
                  </HorizontalCarousel>
                </div>
              )}

              {/* Recent episodes */}
              {playback.recentEpisodes.length > 0 && (
                <div>
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                    <Tv size={14} className="text-sky-400" />
                    {t('jellyfin.recentEpisodes')}
                  </h3>
                  <div className="card divide-y divide-white/5">
                    {playback.recentEpisodes.map((e) => (
                      <a
                        key={e.id}
                        href={`/api/jellyfin/redirect?itemId=${e.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 p-3 hover:bg-white/5"
                      >
                        <div className="h-10 w-16 shrink-0 overflow-hidden rounded-sm bg-slate-800">
                          {e.imageTag ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`/api/jellyfin/image?itemId=${e.id}&tag=${e.imageTag}`}
                              alt={e.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-slate-600">
                              <Tv size={14} />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-white">
                            {e.seriesName ?? e.name}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {e.season != null && e.episode != null
                              ? `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")} · `
                              : ""}
                            {e.name}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-xs text-slate-500">{relDate(e.lastPlayed)}</p>
                          {e.runtimeTicks > 0 && (
                            <p className="text-[11px] text-slate-600">{formatDuration(e.runtimeTicks)}</p>
                          )}
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {playback.recentMovies.length === 0 && playback.recentEpisodes.length === 0 && (
                <EmptyState label={t('jellyfin.noPlayHistory')} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className="rounded-lg bg-slate-800 p-2 text-accent-400">
        <Icon size={20} />
      </div>
      <div>
        <p className="text-lg font-semibold text-white">{value}</p>
        <p className="text-xs text-slate-500">{label}</p>
      </div>
    </div>
  );
}

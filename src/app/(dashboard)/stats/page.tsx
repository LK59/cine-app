"use client";

import useSWR from "swr";
import Link from "next/link";
import { fetcher } from "@/lib/swr";
import { INTERVALS } from "@/lib/refresh-intervals";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { Film, Tv, HardDrive, Layers, Zap, Link2, Copy, Share2, RefreshCw, AlertTriangle, type LucideIcon } from "lucide-react";
import type { LibraryStats } from "@/app/api/stats/library/route";
import type { PeopleStats } from "@/app/api/stats/people/route";
import type { StorageStats } from "@/app/api/stats/storage/route";
import { fmtSize, relativeTimeAbs } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";
import { useRole } from "@/lib/useRole";
import type { DiskForecast } from "@/lib/diskForecast";

interface DiskStats {
  moviesBytes: number;
  tvBytes: number;
  disk: { total: number; used: number; free: number };
}

function ForecastLine({ forecast }: { forecast: DiskForecast | undefined }) {
  const t = useT();
  if (!forecast) return null;

  if (forecast.trend === "insufficient_data") {
    return <p className="text-xs text-slate-600">{t('stats.storage.forecastInsufficientData')}</p>;
  }
  if (forecast.trend === "stable") {
    return <p className="text-xs text-slate-500">{t('stats.storage.forecastStable', { months: String(forecast.monthsUsed) })}</p>;
  }
  const rate = fmtSize((forecast.growthBytesPerDay ?? 0) * 7);
  const days = forecast.daysUntilFull ?? 0;
  const key = days < 7 ? 'stats.storage.forecastGrowingSoon' : 'stats.storage.forecastGrowing';
  const color = days < 14 ? "text-red-400" : days < 45 ? "text-amber-400" : "text-slate-400";
  return <p className={`text-xs ${color}`}>{t(key, { days: String(days), rate })}</p>;
}

function MonthlyGrowthChart({ monthlyGrowth }: { monthlyGrowth: { month: string; bytes: number }[] }) {
  const t = useT();
  const max = Math.max(...monthlyGrowth.map((m) => m.bytes), 1);
  const chartH = 60;

  return (
    <div className="mt-3 border-t border-white/5 pt-3">
      <p className="mb-2 text-[11px] text-slate-500">{t('stats.storage.monthlyGrowthLabel')}</p>
      <div className="flex items-end gap-1" style={{ height: `${chartH + 16}px` }}>
        {monthlyGrowth.map((m) => {
          const barPx = m.bytes > 0 ? Math.max(2, Math.round((m.bytes / max) * chartH)) : 0;
          return (
            <div key={m.month} className="group relative flex flex-1 flex-col items-center gap-1">
              {m.bytes > 0 && (
                <div className="pointer-events-none absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                  {fmtSize(m.bytes)}
                </div>
              )}
              <div className="w-full rounded-t-sm bg-accent-500/70" style={{ height: `${barPx}px` }} />
              <span className="text-[9px] text-slate-600 leading-none">{monthLabel(m.month, t)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function qualityBucket(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("2160") || n.includes("4k") || n.includes("uhd") || n.includes("remux")) return "4K / UHD";
  if (n.includes("1080")) return "1080p";
  if (n.includes("720")) return "720p";
  if (n.includes("480") || n.includes("576")) return "SD";
  return name;
}

function lastMonths(n: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return result;
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

function monthLabel(key: string, t: TFn): string {
  const [y, m] = key.split("-");
  const months = [
    t('stats.months.jan'), t('stats.months.feb'), t('stats.months.mar'),
    t('stats.months.apr'), t('stats.months.may'), t('stats.months.jun'),
    t('stats.months.jul'), t('stats.months.aug'), t('stats.months.sep'),
    t('stats.months.oct'), t('stats.months.nov'), t('stats.months.dec'),
  ];
  return `${months[parseInt(m) - 1]} ${y.slice(2)}`;
}

function StatCard({ icon: Icon, label, value, sub, color = "text-accent-400" }: {
  icon: LucideIcon; label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="card flex items-center gap-4 p-5">
      <div className={`rounded-xl bg-white/5 p-3 ${color} ring-1 ring-inset ring-white/10`}>
        <Icon size={22} />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-white">{value}</p>
        <p className="text-sm text-slate-400">{label}</p>
        {sub && <p className="text-xs text-slate-600 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function HBar({ label, value, max, color, fmt }: {
  label: string; value: number; max: number; color: string; fmt?: (n: number) => string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-500">{fmt ? fmt(value) : value}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-800">
        <div className={`h-2 rounded-full transition-[width] ${color}`} style={{ width: `${(value / max) * 100}%` }} />
      </div>
    </div>
  );
}


function TopPeopleSection({ people }: { people: PeopleStats }) {
  const t = useT();
  const PersonRow = ({ p, i }: { p: PeopleStats["topActors"][number]; i: number }) => (
    <Link href={`/person/${p.tmdbId}`} className="flex items-center gap-3 rounded-lg p-2 hover:bg-white/5 transition-colors">
      <span className="w-5 shrink-0 text-right text-xs text-slate-600">{i + 1}</span>
      {p.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.photoUrl} alt={p.name} className="h-8 w-8 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="h-8 w-8 shrink-0 rounded-full bg-slate-700 flex items-center justify-center text-xs text-slate-400">
          {p.name[0]}
        </div>
      )}
      <span className="flex-1 truncate text-sm text-slate-300">{p.name}</span>
      <span className="shrink-0 text-xs font-semibold text-accent-400">{t('stats.topPeopleCount', { n: p.count })}</span>
    </Link>
  );

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-300">{t('stats.topActors')}</h3>
        <div className="space-y-1">
          {people.topActors.map((p, i) => <PersonRow key={p.tmdbId} p={p} i={i} />)}
        </div>
      </div>
      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-300">{t('stats.topDirectors')}</h3>
        <div className="space-y-1">
          {people.topDirectors.map((p, i) => <PersonRow key={p.tmdbId} p={p} i={i} />)}
        </div>
      </div>
    </div>
  );
}

function ListCard({ icon: Icon, iconColor, title, count, emptyLabel, children }: {
  icon: LucideIcon; iconColor: string; title: string; count: number; emptyLabel: string; children: React.ReactNode;
}) {
  return (
    <div className="card p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-300">
        <Icon size={14} className={iconColor} /> {title}
        {count > 0 && <span className="ml-auto text-xs font-normal text-slate-600">{count}</span>}
      </h3>
      {count === 0 ? (
        <p className="text-xs text-slate-600">{emptyLabel}</p>
      ) : (
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">{children}</div>
      )}
    </div>
  );
}

function StorageSection({ storage, onRefresh, forecast, isAdmin }: { storage: StorageStats; onRefresh: () => void; forecast: DiskForecast | undefined; isAdmin: boolean }) {
  const t = useT();
  const movieMax = Math.max(storage.movieFiles.total, 1);
  const seriesMax = Math.max(storage.seriesFiles.total, 1);

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          {t('stats.storage.title')}
          <span className="rounded-full bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-400 ring-1 ring-inset ring-accent-500/30">
            {t('stats.storage.beta')}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          {storage.computedAt > 0 && (
            <span className="text-xs text-slate-600">{t('stats.storage.lastScan', { time: relativeTimeAbs(storage.computedAt, t) })}</span>
          )}
          <button
            onClick={onRefresh}
            disabled={storage.computing}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:text-white disabled:opacity-50"
          >
            <RefreshCw size={12} className={storage.computing ? "animate-spin" : ""} />
            {storage.computing ? t('stats.storage.refreshing') : t('stats.storage.refresh')}
          </button>
        </div>
      </div>

      {isAdmin && (
        <div className="card mb-5 p-4">
          <h3 className="mb-1.5 text-sm font-semibold text-slate-300">{t('stats.storage.forecastTitle')}</h3>
          <ForecastLine forecast={forecast} />
          {forecast && forecast.monthlyGrowth.some((m) => m.bytes > 0) && (
            <MonthlyGrowthChart monthlyGrowth={forecast.monthlyGrowth} />
          )}
        </div>
      )}

      <div className="mb-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card p-4 space-y-3">
          <HBar label={t('stats.storage.hardlinkMovies')} value={storage.movieFiles.hardlinked} max={movieMax}
            color="bg-accent-500" fmt={() => t('stats.storage.hardlinkCount', { linked: storage.movieFiles.hardlinked, total: storage.movieFiles.total })} />
          <HBar label={t('stats.storage.hardlinkSeries')} value={storage.seriesFiles.hardlinked} max={seriesMax}
            color="bg-sky-500" fmt={() => t('stats.storage.hardlinkCount', { linked: storage.seriesFiles.hardlinked, total: storage.seriesFiles.total })} />
        </div>
        <StatCard icon={HardDrive} label={t('stats.storage.seedOrphans')} value={fmtSize(storage.seedOrphanBytes)}
          sub={t('stats.storage.seedOrphanCount', { n: storage.seedOrphans.length })} color="text-rose-400" />
      </div>

      <div className="mb-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ListCard icon={AlertTriangle} iconColor="text-rose-400" title={t('stats.storage.seedOrphansTitle')}
          count={storage.seedOrphans.length} emptyLabel={t('stats.storage.seedOrphansEmpty')}>
          {storage.seedOrphans.map((item, i) => (
            <div key={i} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-slate-300" title={item.fileName}>
                  {item.title}
                  {item.trackers.length > 0 && <span className="ml-1.5 text-[10px] text-sky-500">({item.trackers.join(", ")})</span>}
                </span>
                <span className="shrink-0 flex items-center gap-1.5">
                  {item.activeInQbittorrent && (
                    <span className="rounded bg-sky-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-sky-400" title={t('stats.storage.activeSeedHint')}>
                      {t('stats.storage.activeSeed')}
                    </span>
                  )}
                  {item.inCatalog ? (
                    <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-amber-400" title={t('stats.storage.knownHint')}>
                      {t('stats.storage.known')}
                    </span>
                  ) : (
                    <span className="rounded bg-rose-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-rose-400" title={t('stats.storage.trueOrphanHint')}>
                      {t('stats.storage.trueOrphan')}
                    </span>
                  )}
                  <span className="text-slate-500">{fmtSize(item.sizeBytes)}</span>
                </span>
              </div>
              <div className="mt-0.5 pl-2 text-[10px] text-slate-600">
                {item.paths.map((p) => (
                  <div key={p} className="truncate" title={p}>{p}</div>
                ))}
              </div>
            </div>
          ))}
        </ListCard>

        <ListCard icon={Copy} iconColor="text-amber-400" title={t('stats.storage.duplicatesTitle')}
          count={storage.duplicates.length} emptyLabel={t('stats.storage.duplicatesEmpty')}>
          {storage.duplicates.map((item, i) => (
            <div key={i} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-slate-300" title={item.title}>{item.title}</span>
                <span className="shrink-0 text-amber-400">{t('stats.storage.duplicatesWasted', { n: fmtSize(item.wastedBytes) })}</span>
              </div>
              <div className="mt-0.5 pl-2 text-[10px] text-slate-600">
                {item.releases.map((r) => (
                  <div key={r.relativePath} className="truncate" title={r.relativePath}>
                    {r.name} ({fmtSize(r.sizeBytes)}){r.inLibrary ? "" : ` · ${t('stats.storage.seedCopy')}`}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </ListCard>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-300">
            <Share2 size={14} className="text-sky-400" /> {t('stats.storage.crossSeedTitle')}
          </h3>
          {storage.crossSeedByTracker.length === 0 ? (
            <p className="text-xs text-slate-600">{t('stats.storage.crossSeedEmpty')}</p>
          ) : (
            <div className="space-y-3">
              {storage.crossSeedByTracker.map((group) => (
                <details key={group.tracker} className="group">
                  <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs text-slate-300 marker:content-none">
                    <span className="font-medium">{group.tracker}</span>
                    <span className="text-slate-500">{group.files.length} · {fmtSize(group.totalBytes)}</span>
                  </summary>
                  <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto pl-2 pr-1">
                    {group.files.map((f, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate text-slate-400" title={f.relativePath}>{f.title}</span>
                        <span className="shrink-0 flex items-center gap-1.5">
                          {!f.linkedToLibrary && <span className="text-rose-400">{t('stats.storage.notLinked')}</span>}
                          <span className="text-slate-600">{fmtSize(f.sizeBytes)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>

        <ListCard icon={Film} iconColor="text-orange-400" title={t('stats.storage.heavyH264Title')}
          count={storage.heaviestH264.length} emptyLabel={t('stats.storage.heavyH264Empty')}>
          {storage.heaviestH264.map((item, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-slate-300" title={item.title}>{item.title}</span>
              <span className="shrink-0 text-orange-400">{fmtSize(item.sizeBytes)}</span>
            </div>
          ))}
        </ListCard>
      </div>

      <ListCard icon={Link2} iconColor="text-slate-500" title={t('stats.storage.notHardlinkedTitle')}
        count={storage.notHardlinked.length} emptyLabel={t('stats.storage.notHardlinkedEmpty')}>
        {storage.notHardlinked.map((item, i) => (
          <div key={i} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-slate-400" title={item.fileName}>{item.title}</span>
            <span className="shrink-0 text-slate-600">{fmtSize(item.sizeBytes)}</span>
          </div>
        ))}
      </ListCard>
    </section>
  );
}

const CHART_H = 120;

export default function StatsPage() {
  const t = useT();
  const { role } = useRole();
  const isAdmin = role === "admin";
  const { data: lib, error: libError, isLoading, mutate: retryLib } = useSWR<LibraryStats>(
    "/api/stats/library", fetcher, { refreshInterval: INTERVALS.SLOW }
  );
  const { data: disk } = useSWR<DiskStats>("/api/stats", fetcher, { refreshInterval: INTERVALS.SLOW });
  // Regular (polling) SWR, not immutable: the route now returns instantly with a possibly-stale
  // or empty result while it recomputes in the background (fire-and-forget, like storage stats),
  // so the client needs to keep checking back until the first computation lands.
  const { data: people } = useSWR<PeopleStats>("/api/stats/people", fetcher, { refreshInterval: INTERVALS.SLOW });
  const { data: storage, mutate: refreshStorage } = useSWR<StorageStats>("/api/stats/storage", fetcher, { refreshInterval: INTERVALS.SLOW });
  // Admin-only, both server- (403 for guests) and client-gated — null key skips the fetch entirely.
  const { data: forecast } = useSWR<DiskForecast>(
    isAdmin ? "/api/stats/storage-forecast" : null,
    fetcher,
    { refreshInterval: INTERVALS.SLOW }
  );

  async function handleStorageRefresh() {
    await fetch("/api/stats/storage?refresh=1");
    refreshStorage();
  }

  const months = lastMonths(12);

  const buckets: Record<string, number> = {};
  if (lib) {
    for (const [name, count] of Object.entries(lib.quality)) {
      const b = qualityBucket(name);
      buckets[b] = (buckets[b] ?? 0) + count;
    }
  }
  const bucketOrder = ["4K / UHD", "1080p", "720p", "SD"];
  const bucketColors: Record<string, string> = {
    "4K / UHD": "bg-accent-500",
    "1080p": "bg-sky-500",
    "720p": "bg-emerald-500",
    "SD": "bg-slate-500",
  };
  const maxBucket = Math.max(...Object.values(buckets), 1);

  const maxMonthly = Math.max(
    ...months.map((m) => (lib?.monthlyMovies[m] ?? 0) + (lib?.monthlySeries[m] ?? 0)),
    1
  );

  const topGenres = lib
    ? Object.entries(lib.genres).sort((a, b) => b[1] - a[1]).slice(0, 10)
    : [];
  const maxGenre = topGenres[0]?.[1] ?? 1;

  const sortedDecades = lib?.decades
    ? Object.entries(lib.decades).sort(([a], [b]) => parseInt(a) - parseInt(b))
    : [];
  const maxDecade = sortedDecades[0] ? Math.max(...sortedDecades.map(([, v]) => v), 1) : 1;

  return (
    <div>
      <PageHeader title={t('stats.pageTitle')} subtitle={t('stats.subtitle')} />

      {isLoading && <LoadingState label={t('stats.loading')} />}
      {libError && <ErrorState message={t('stats.error')} onRetry={() => retryLib()} />}

      {lib && (
        <>
          {/* Summary cards */}
          <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard icon={Film} label={t('stats.cards.movies')} value={lib.movies.total}
              sub={t('stats.cards.downloaded', { n: lib.movies.withFile })} />
            <StatCard icon={Tv} label={t('stats.cards.series')} value={lib.series.total}
              color="text-sky-400" />
            <StatCard icon={Layers} label={t('stats.cards.episodes')}
              value={lib.series.episodesWithFile.toLocaleString()}
              sub={t('stats.episodesOf', { n: lib.series.totalEpisodes.toLocaleString() })}
              color="text-emerald-400" />
            <StatCard icon={HardDrive} label={t('stats.cards.storage')}
              value={disk ? fmtSize(disk.moviesBytes + disk.tvBytes) : "—"}
              sub={disk && disk.disk.total > 0 ? t('stats.cards.free', { n: fmtSize(disk.disk.free) }) : undefined}
              color="text-amber-400" />
          </div>

          {/* Disk bar */}
          {disk && disk.disk.total > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold text-white">{t('stats.diskStorage')}</h2>
              <div className="card p-4">
                <div className="mb-1 flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
                  {disk.moviesBytes > 0 && (
                    <div className="h-full bg-accent-500" style={{ width: `${(disk.moviesBytes / disk.disk.total) * 100}%` }}
                      title={`${t('stats.diskLegend.movies')} : ${fmtSize(disk.moviesBytes)}`} />
                  )}
                  {disk.tvBytes > 0 && (
                    <div className="h-full bg-sky-500" style={{ width: `${(disk.tvBytes / disk.disk.total) * 100}%` }}
                      title={`${t('stats.diskLegend.series')} : ${fmtSize(disk.tvBytes)}`} />
                  )}
                  {disk.disk.used - disk.moviesBytes - disk.tvBytes > 0 && (
                    <div className="h-full bg-slate-600"
                      style={{ width: `${((disk.disk.used - disk.moviesBytes - disk.tvBytes) / disk.disk.total) * 100}%` }} />
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-500" />{t('stats.diskLegend.movies')} — {fmtSize(disk.moviesBytes)}</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" />{t('stats.diskLegend.series')} — {fmtSize(disk.tvBytes)}</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-600" />{t('stats.diskLegend.other')} — {fmtSize(Math.max(0, disk.disk.used - disk.moviesBytes - disk.tvBytes))}</span>
                  <span className="ml-auto text-slate-500">{t('stats.diskUsed', { pct: ((disk.disk.used / disk.disk.total) * 100).toFixed(1) })}</span>
                </div>
                {isAdmin && (
                  <div className="mt-3 border-t border-white/5 pt-3">
                    <ForecastLine forecast={forecast} />
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Storage cleanup */}
          {storage && storage.computedAt > 0 && (
            <StorageSection storage={storage} onRefresh={handleStorageRefresh} forecast={forecast} isAdmin={isAdmin} />
          )}

          {/* Monthly additions */}
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold text-white">{t('stats.monthlyAdditions')}</h2>
            <div className="card p-4">
              <div className="flex items-end gap-1.5" style={{ height: `${CHART_H + 20}px` }}>
                {months.map((m) => {
                  const mv = lib.monthlyMovies[m] ?? 0;
                  const sv = lib.monthlySeries[m] ?? 0;
                  const total = mv + sv;
                  const barPx = total > 0 ? Math.max(4, Math.round((total / maxMonthly) * CHART_H)) : 0;
                  return (
                    <div key={m} className="group relative flex flex-1 flex-col items-center gap-1">
                      {total > 0 && (
                        <div className="pointer-events-none absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                          {mv > 0 && <span className="text-accent-400">{mv}F </span>}
                          {sv > 0 && <span className="text-sky-400">{sv}S</span>}
                        </div>
                      )}
                      <div className="w-full overflow-hidden rounded-t-sm flex flex-col" style={{ height: `${barPx}px` }}>
                        {sv > 0 && <div className="w-full bg-sky-500" style={{ flex: sv }} />}
                        {mv > 0 && <div className="w-full bg-accent-500" style={{ flex: mv }} />}
                      </div>
                      <span className="text-[9px] text-slate-600 leading-none">{monthLabel(m, t)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex gap-4 text-xs text-slate-400">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-500" /> {t('stats.monthlyLegend.movies')}</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" /> {t('stats.monthlyLegend.series')}</span>
              </div>
            </div>
          </section>

          <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Quality breakdown */}
            {Object.keys(buckets).length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">{t('stats.movieQuality')}</h2>
                <div className="card p-4 space-y-3">
                  {bucketOrder.filter((b) => buckets[b]).map((b) => (
                    <HBar key={b} label={b} value={buckets[b]} max={maxBucket}
                      color={bucketColors[b] ?? "bg-slate-400"} fmt={(n) => t('stats.movieQualityCount', { n })} />
                  ))}
                  {Object.entries(buckets).filter(([b]) => !bucketOrder.includes(b)).map(([b, count]) => (
                    <HBar key={b} label={b} value={count} max={maxBucket} color="bg-slate-400" fmt={(n) => t('stats.movieQualityCount', { n })} />
                  ))}
                </div>
              </section>
            )}

            {/* Language stats */}
            {lib.movies.withFile > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">{t('stats.audioLanguages')}</h2>
                <div className="card p-4 space-y-3">
                  {(["vfvo", "vf", "vo", "other"] as const).map((cat) => {
                    const count = lib.languages[cat];
                    if (!count) return null;
                    const labels = { vfvo: t('stats.audioLang.vfvo'), vf: t('stats.audioLang.vf'), vo: t('stats.audioLang.vo'), other: t('stats.audioLang.other') };
                    const colors = { vfvo: "bg-accent-500", vf: "bg-emerald-500", vo: "bg-sky-500", other: "bg-slate-500" };
                    return (
                      <HBar key={cat} label={labels[cat]} value={count}
                        max={lib.movies.withFile} color={colors[cat]} fmt={(n) => t('stats.movieQualityCount', { n })} />
                    );
                  })}
                </div>
              </section>
            )}

            {/* Codec breakdown */}
            {lib.movies.withFile > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">{t('stats.videoEncoding')}</h2>
                <div className="card p-4 space-y-3">
                  <HBar label="H.265 / HEVC" value={lib.codecs.hevc} max={lib.movies.withFile}
                    color="bg-accent-500" fmt={(n) => t('stats.movieQualityCount', { n })} />
                  <HBar label="H.264 / AVC" value={lib.codecs.h264} max={lib.movies.withFile}
                    color="bg-sky-500" fmt={(n) => t('stats.movieQualityCount', { n })} />
                  {lib.codecs.other > 0 && (
                    <HBar label={t('stats.audioLang.other')} value={lib.codecs.other} max={lib.movies.withFile}
                      color="bg-slate-500" fmt={(n) => t('stats.movieQualityCount', { n })} />
                  )}
                  <div className="border-t border-white/5 pt-3 flex items-center gap-3 text-xs text-slate-400">
                    <Zap size={12} className="text-amber-400" />
                    <span>{t('stats.hdrCount', { n: lib.hdr, pct: Math.round(lib.hdr / lib.movies.withFile * 100) })}</span>
                  </div>
                </div>
              </section>
            )}

            {/* Top genres */}
            {topGenres.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">{t('stats.topGenres')}</h2>
                <div className="card p-4 space-y-2.5">
                  {topGenres.map(([genre, count]) => (
                    <HBar key={genre} label={genre} value={count} max={maxGenre} color="bg-accent-500/60" />
                  ))}
                </div>
              </section>
            )}

            {/* Decades */}
            {sortedDecades.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">{t('stats.byDecade')}</h2>
                <div className="card p-4 space-y-2.5">
                  {sortedDecades.map(([decade, count]) => (
                    <HBar key={decade} label={decade} value={count} max={maxDecade}
                      color="bg-sky-500/60" fmt={(n) => t('stats.decadeTitles', { n })} />
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Top actors & directors */}
          {people && (people.topActors.length > 0 || people.topDirectors.length > 0) && (
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold text-white">{t('stats.topPeople')}</h2>
              <TopPeopleSection people={people} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

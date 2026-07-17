"use client";

import useSWR from "swr";
import useSWRImmutable from "swr/immutable";
import Link from "next/link";
import { fetcher } from "@/lib/swr";
import { INTERVALS } from "@/lib/refresh-intervals";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { Film, Tv, HardDrive, Layers, Zap, type LucideIcon } from "lucide-react";
import type { LibraryStats } from "@/app/api/stats/library/route";
import type { PeopleStats } from "@/app/api/stats/people/route";
import { fmtSize } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";

interface DiskStats {
  moviesBytes: number;
  tvBytes: number;
  disk: { total: number; used: number; free: number };
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

const CHART_H = 120;

export default function StatsPage() {
  const t = useT();
  const { data: lib, error: libError, isLoading } = useSWR<LibraryStats>(
    "/api/stats/library", fetcher, { refreshInterval: INTERVALS.SLOW }
  );
  const { data: disk } = useSWR<DiskStats>("/api/stats", fetcher, { refreshInterval: INTERVALS.SLOW });
  const { data: people } = useSWRImmutable<PeopleStats>("/api/stats/people", fetcher);

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
      {libError && <ErrorState message={t('stats.error')} />}

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
              </div>
            </section>
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

"use client";

import useSWR from "swr";
import useSWRImmutable from "swr/immutable";
import Link from "next/link";
import { fetcher } from "@/lib/swr";
import { INTERVALS } from "@/lib/refresh-intervals";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { Film, Tv, HardDrive, Layers, Download, Upload, Zap, type LucideIcon } from "lucide-react";
import type { LibraryStats } from "@/app/api/stats/library/route";
import type { HeatmapData } from "@/app/api/stats/heatmap/route";
import type { PeopleStats } from "@/app/api/stats/people/route";
import { fmtSize } from "@/lib/format";

interface DiskStats {
  moviesBytes: number;
  tvBytes: number;
  disk: { total: number; used: number; free: number };
}

interface TransferInfo {
  alltime_dl: number;
  alltime_ul: number;
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

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const months = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
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
        <div className={`h-2 rounded-full transition-all ${color}`} style={{ width: `${(value / max) * 100}%` }} />
      </div>
    </div>
  );
}

function HeatmapChart({ data }: { data: HeatmapData }) {
  const weeks: { date: string; count: number }[][] = [];
  let week: { date: string; count: number }[] = [];

  const firstDay = new Date(data.days[0].date);
  const startPad = (firstDay.getDay() + 6) % 7;
  for (let i = 0; i < startPad; i++) week.push({ date: "", count: -1 });

  for (const day of data.days) {
    week.push(day);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) weeks.push(week);

  function cellColor(count: number, max: number): string {
    if (count <= 0) return "bg-white/5";
    const ratio = count / max;
    if (ratio < 0.25) return "bg-accent-900/60";
    if (ratio < 0.5) return "bg-accent-700/70";
    if (ratio < 0.75) return "bg-accent-500/80";
    return "bg-accent-400";
  }

  return (
    <div className="card p-5">
      <h3 className="mb-4 text-sm font-semibold text-slate-300">Activité de téléchargement — 12 mois</h3>
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-1 min-w-max">
          {weeks.map((w, wi) => (
            <div key={wi} className="flex flex-col gap-1">
              {w.map((d, di) => (
                <div
                  key={di}
                  title={d.date && d.count >= 0 ? `${d.date} : ${d.count} téléchargement${d.count !== 1 ? "s" : ""}` : ""}
                  className={`h-3 w-3 rounded-sm transition-colors ${d.count === -1 ? "opacity-0" : cellColor(d.count, data.max)}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-600">
        <span>Moins</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <div key={level} className={`h-3 w-3 rounded-sm ${
            level === 0 ? "bg-white/5"
            : level === 1 ? "bg-accent-900/60"
            : level === 2 ? "bg-accent-700/70"
            : level === 3 ? "bg-accent-500/80"
            : "bg-accent-400"
          }`} />
        ))}
        <span>Plus</span>
      </div>
    </div>
  );
}

function TopPeopleSection({ people }: { people: PeopleStats }) {
  const PersonRow = ({ p, i, unit }: { p: PeopleStats["topActors"][number]; i: number; unit: string }) => (
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
      <span className="shrink-0 text-xs font-semibold text-accent-400">{p.count} {unit}{p.count > 1 ? "s" : ""}</span>
    </Link>
  );

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-300">Acteurs les plus présents</h3>
        <div className="space-y-1">
          {people.topActors.map((p, i) => <PersonRow key={p.tmdbId} p={p} i={i} unit="film" />)}
        </div>
      </div>
      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-300">Réalisateurs les plus présents</h3>
        <div className="space-y-1">
          {people.topDirectors.map((p, i) => <PersonRow key={p.tmdbId} p={p} i={i} unit="film" />)}
        </div>
      </div>
    </div>
  );
}

const CHART_H = 120;

export default function StatsPage() {
  const { data: lib, error: libError, isLoading } = useSWR<LibraryStats>(
    "/api/stats/library", fetcher, { refreshInterval: INTERVALS.SLOW }
  );
  const { data: disk } = useSWR<DiskStats>("/api/stats", fetcher, { refreshInterval: INTERVALS.SLOW });
  const { data: transfer } = useSWR<TransferInfo>("/api/qbittorrent/transfer", fetcher, { refreshInterval: INTERVALS.SLOW });
  const { data: heatmap } = useSWRImmutable<HeatmapData>("/api/stats/heatmap", fetcher);
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
      <PageHeader title="Statistiques" subtitle="Vue d'ensemble de votre médiathèque" />

      {isLoading && <LoadingState label="Calcul des statistiques…" />}
      {libError && <ErrorState message="Impossible de récupérer les statistiques." />}

      {lib && (
        <>
          {/* Summary cards */}
          <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard icon={Film} label="Films" value={lib.movies.total}
              sub={`${lib.movies.withFile} téléchargés`} />
            <StatCard icon={Tv} label="Séries" value={lib.series.total}
              color="text-sky-400" />
            <StatCard icon={Layers} label="Épisodes"
              value={lib.series.episodesWithFile.toLocaleString("fr-FR")}
              sub={`sur ${lib.series.totalEpisodes.toLocaleString("fr-FR")}`}
              color="text-emerald-400" />
            <StatCard icon={HardDrive} label="Stockage média"
              value={disk ? fmtSize(disk.moviesBytes + disk.tvBytes) : "—"}
              sub={disk && disk.disk.total > 0 ? `${fmtSize(disk.disk.free)} libres` : undefined}
              color="text-amber-400" />
          </div>

          {/* qBit transfer stats */}
          {transfer && (transfer.alltime_dl > 0 || transfer.alltime_ul > 0) && (
            <div className="mb-8 grid grid-cols-2 gap-4">
              <StatCard icon={Download} label="Téléchargé (total)" value={fmtSize(transfer.alltime_dl)}
                color="text-emerald-400" />
              <StatCard icon={Upload} label="Uploadé (total)" value={fmtSize(transfer.alltime_ul)}
                color="text-sky-400" />
            </div>
          )}

          {/* Disk bar */}
          {disk && disk.disk.total > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold text-white">Stockage disque</h2>
              <div className="card p-4">
                <div className="mb-1 flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
                  {disk.moviesBytes > 0 && (
                    <div className="h-full bg-accent-500" style={{ width: `${(disk.moviesBytes / disk.disk.total) * 100}%` }}
                      title={`Films : ${fmtSize(disk.moviesBytes)}`} />
                  )}
                  {disk.tvBytes > 0 && (
                    <div className="h-full bg-sky-500" style={{ width: `${(disk.tvBytes / disk.disk.total) * 100}%` }}
                      title={`Séries : ${fmtSize(disk.tvBytes)}`} />
                  )}
                  {disk.disk.used - disk.moviesBytes - disk.tvBytes > 0 && (
                    <div className="h-full bg-slate-600"
                      style={{ width: `${((disk.disk.used - disk.moviesBytes - disk.tvBytes) / disk.disk.total) * 100}%` }} />
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-500" />Films — {fmtSize(disk.moviesBytes)}</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" />Séries — {fmtSize(disk.tvBytes)}</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-600" />Autre — {fmtSize(Math.max(0, disk.disk.used - disk.moviesBytes - disk.tvBytes))}</span>
                  <span className="ml-auto text-slate-500">{((disk.disk.used / disk.disk.total) * 100).toFixed(1)}% utilisé</span>
                </div>
              </div>
            </section>
          )}

          {/* Monthly additions */}
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold text-white">Ajouts mensuels (12 derniers mois)</h2>
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
                        <div className="pointer-events-none absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                          {mv > 0 && <span className="text-accent-400">{mv}F </span>}
                          {sv > 0 && <span className="text-sky-400">{sv}S</span>}
                        </div>
                      )}
                      <div className="w-full overflow-hidden rounded-t-sm flex flex-col" style={{ height: `${barPx}px` }}>
                        {sv > 0 && <div className="w-full bg-sky-500" style={{ flex: sv }} />}
                        {mv > 0 && <div className="w-full bg-accent-500" style={{ flex: mv }} />}
                      </div>
                      <span className="text-[9px] text-slate-600 leading-none">{monthLabel(m)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex gap-4 text-xs text-slate-400">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-500" /> Films</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" /> Séries</span>
              </div>
            </div>
          </section>

          <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Quality breakdown */}
            {Object.keys(buckets).length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">Qualité des films</h2>
                <div className="card p-4 space-y-3">
                  {bucketOrder.filter((b) => buckets[b]).map((b) => (
                    <HBar key={b} label={b} value={buckets[b]} max={maxBucket}
                      color={bucketColors[b] ?? "bg-slate-400"} fmt={(n) => `${n} films`} />
                  ))}
                  {Object.entries(buckets).filter(([b]) => !bucketOrder.includes(b)).map(([b, count]) => (
                    <HBar key={b} label={b} value={count} max={maxBucket} color="bg-slate-400" fmt={(n) => `${n} films`} />
                  ))}
                </div>
              </section>
            )}

            {/* Language stats */}
            {lib.movies.withFile > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">Langues audio (films)</h2>
                <div className="card p-4 space-y-3">
                  {(["vfvo", "vf", "vo", "other"] as const).map((cat) => {
                    const count = lib.languages[cat];
                    if (!count) return null;
                    const labels = { vfvo: "VF + VO", vf: "VF uniquement", vo: "VO uniquement", other: "Autre" };
                    const colors = { vfvo: "bg-accent-500", vf: "bg-emerald-500", vo: "bg-sky-500", other: "bg-slate-500" };
                    return (
                      <HBar key={cat} label={labels[cat]} value={count}
                        max={lib.movies.withFile} color={colors[cat]} fmt={(n) => `${n} films`} />
                    );
                  })}
                </div>
              </section>
            )}

            {/* Codec breakdown */}
            {lib.movies.withFile > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">Encodage vidéo</h2>
                <div className="card p-4 space-y-3">
                  <HBar label="H.265 / HEVC" value={lib.codecs.hevc} max={lib.movies.withFile}
                    color="bg-accent-500" fmt={(n) => `${n} films`} />
                  <HBar label="H.264 / AVC" value={lib.codecs.h264} max={lib.movies.withFile}
                    color="bg-sky-500" fmt={(n) => `${n} films`} />
                  {lib.codecs.other > 0 && (
                    <HBar label="Autre" value={lib.codecs.other} max={lib.movies.withFile}
                      color="bg-slate-500" fmt={(n) => `${n} films`} />
                  )}
                  <div className="border-t border-white/5 pt-3 flex items-center gap-3 text-xs text-slate-400">
                    <Zap size={12} className="text-amber-400" />
                    <span><span className="text-white font-medium">{lib.hdr}</span> films HDR ({Math.round(lib.hdr / lib.movies.withFile * 100)}%)</span>
                  </div>
                </div>
              </section>
            )}

            {/* Top genres */}
            {topGenres.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-white">Top genres</h2>
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
                <h2 className="mb-3 text-sm font-semibold text-white">Répartition par décennie</h2>
                <div className="card p-4 space-y-2.5">
                  {sortedDecades.map(([decade, count]) => (
                    <HBar key={decade} label={decade} value={count} max={maxDecade}
                      color="bg-sky-500/60" fmt={(n) => `${n} titres`} />
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Heatmap */}
          {heatmap && (
            <section className="mb-8">
              <HeatmapChart data={heatmap} />
            </section>
          )}

          {/* Top actors & directors */}
          {people && (people.topActors.length > 0 || people.topDirectors.length > 0) && (
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold text-white">Personnes les plus présentes</h2>
              <TopPeopleSection people={people} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

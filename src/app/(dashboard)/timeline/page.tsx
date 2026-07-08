"use client";

import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, EmptyState } from "@/components/StateViews";
import { INTERVALS } from "@/lib/refresh-intervals";
import { Film, Tv, Download, PackageCheck, Clock } from "lucide-react";
import { useLocalState } from "@/hooks/useLocalState";
import { type ImportEvent, groupByDay } from "@/lib/timeline";

type Filter = "all" | "movie" | "series";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} j`;
  return new Date(dateStr).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function EventRow({ ev }: { ev: ImportEvent }) {
  const Icon = ev.type === "movie" ? Film : Tv;
  const isImport = ev.eventKind === "import";

  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.03]">
      {/* Poster */}
      <div className="h-12 w-8 shrink-0 overflow-hidden rounded bg-slate-800">
        {ev.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ev.posterPath} alt={ev.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Icon size={12} className="text-slate-600" />
          </div>
        )}
      </div>

      {/* Event icon */}
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${isImport ? "bg-emerald-500/15 text-emerald-400" : "bg-sky-500/15 text-sky-400"}`}>
        {isImport ? <PackageCheck size={13} /> : <Download size={13} />}
      </div>

      {/* Title + detail */}
      <div className="min-w-0 flex-1">
        {ev.href ? (
          <Link href={ev.href} className="block truncate text-sm font-medium text-white hover:text-accent-400">
            {ev.title}
          </Link>
        ) : (
          <p className="truncate text-sm font-medium text-white">{ev.title}</p>
        )}
        {ev.detail && <p className="truncate text-xs text-slate-500">{ev.detail}</p>}
      </div>

      {/* Badges + time */}
      <div className="flex shrink-0 items-center gap-2">
        <span className={`hidden rounded px-1.5 py-0.5 text-[10px] font-medium sm:inline ${ev.source === "radarr" ? "bg-accent-600/15 text-accent-400" : "bg-sky-600/15 text-sky-400"}`}>
          {ev.type === "movie" ? "Film" : "Série"}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${isImport ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-700/60 text-slate-400"}`}>
          {isImport ? "Importé" : "Récupéré"}
        </span>
        <span className="w-10 text-right text-[11px] text-slate-600">{timeAgo(ev.date)}</span>
      </div>
    </div>
  );
}

interface ImportsResponse { events: ImportEvent[] }

export default function TimelinePage() {
  const [filter, setFilter] = useLocalState<Filter>("timeline-filter", "all");

  const { data, isLoading } = useSWR<ImportsResponse>(
    "/api/timeline/imports",
    fetcher,
    { refreshInterval: INTERVALS.MEDIUM }
  );

  const allEvents = data?.events ?? [];
  const filtered = allEvents.filter((e) => filter === "all" || e.type === filter);
  const groups = groupByDay(filtered);

  const movieCount = allEvents.filter((e) => e.type === "movie").length;
  const seriesCount = allEvents.filter((e) => e.type === "series").length;

  return (
    <div>
      <PageHeader
        title="Téléchargements"
        subtitle={`${allEvents.length} événements récents — Radarr & Sonarr`}
      />

      {/* Filters */}
      <div className="mb-5 flex items-center gap-2">
        {(["all", "movie", "series"] as Filter[]).map((f) => {
          const label = f === "all" ? `Tout (${allEvents.length})` : f === "movie" ? `Films (${movieCount})` : `Séries (${seriesCount})`;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f
                  ? "border-accent-500/40 bg-accent-500/10 text-accent-400"
                  : "border-white/10 text-slate-500 hover:text-slate-300"
              }`}
            >
              {f === "movie" && <Film size={11} />}
              {f === "series" && <Tv size={11} />}
              {f === "all" && <Clock size={11} />}
              {label}
            </button>
          );
        })}
      </div>

      {isLoading && <LoadingState label="Chargement…" />}
      {!isLoading && filtered.length === 0 && <EmptyState label="Aucun événement récent." />}

      {groups.length > 0 && (
        <div className="space-y-6">
          {groups.map(({ label, items }) => (
            <div key={label}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
              <div className="card divide-y divide-white/5 overflow-hidden">
                {items.map((ev) => <EventRow key={ev.id} ev={ev} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

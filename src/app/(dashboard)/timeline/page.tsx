"use client";

import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, EmptyState } from "@/components/StateViews";
import { INTERVALS } from "@/lib/refresh-intervals";
import { Film, Tv, Download, PackageCheck, Clock } from "lucide-react";
import { useState } from "react";

// Simplified timeline focused on imports only
interface ImportEvent {
  id: string;
  date: string;
  type: "movie" | "series";
  title: string;
  detail: string | null;    // season/episode for series, quality for movies
  posterPath: string | null;
  href: string | null;
  source: "radarr" | "sonarr";
  eventKind: "import" | "grab";
}

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
  const poster = ev.posterPath ?? null; // already a full URL from posterUrl()
  const Icon = ev.type === "movie" ? Film : Tv;
  const isImport = ev.eventKind === "import";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5 transition-colors hover:bg-white/[0.04]">
      {/* Poster thumbnail */}
      <div className="h-12 w-8 shrink-0 overflow-hidden rounded bg-slate-800">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt={ev.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Icon size={12} className="text-slate-600" />
          </div>
        )}
      </div>

      {/* Event type icon */}
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

      {/* Badge + time */}
      <div className="flex shrink-0 items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ev.source === "radarr" ? "bg-accent-600/15 text-accent-400" : "bg-sky-600/15 text-sky-400"}`}>
          {isImport ? "Importé" : "Récupéré"}
        </span>
        <span className="w-10 text-right text-[11px] text-slate-600">{timeAgo(ev.date)}</span>
      </div>
    </div>
  );
}

interface ImportsResponse {
  events: ImportEvent[];
}

export default function TimelinePage() {
  const [filter, setFilter] = useState<Filter>("all");

  const { data, isLoading } = useSWR<ImportsResponse>(
    "/api/timeline/imports",
    fetcher,
    { refreshInterval: INTERVALS.MEDIUM }
  );

  const events = (data?.events ?? []).filter(
    (e) => filter === "all" || e.type === filter
  );

  const movieCount = data?.events.filter((e) => e.type === "movie").length ?? 0;
  const seriesCount = data?.events.filter((e) => e.type === "series").length ?? 0;

  return (
    <div>
      <PageHeader
        title="Imports récents"
        subtitle="Les 50 derniers téléchargements importés dans Radarr et Sonarr"
      />

      {/* Filters */}
      <div className="mb-5 flex items-center gap-2">
        {(["all", "movie", "series"] as Filter[]).map((f) => {
          const label = f === "all" ? `Tout (${(data?.events.length ?? 0)})` : f === "movie" ? `Films (${movieCount})` : `Séries (${seriesCount})`;
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

      {isLoading && <LoadingState label="Chargement des imports…" />}
      {!isLoading && events.length === 0 && <EmptyState label="Aucun import récent trouvé." />}

      {events.length > 0 && (
        <div className="space-y-1.5">
          {events.map((ev) => <EventRow key={ev.id} ev={ev} />)}
        </div>
      )}
    </div>
  );
}

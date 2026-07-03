"use client";

import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { PosterImage } from "@/components/PosterImage";
import { LoadingState, EmptyState } from "@/components/StateViews";
import { Eye, Heart, X, Clock, CheckCircle2, Film, Tv, Trash2, PlusCircle, ExternalLink } from "lucide-react";
import type { WatchlistItem, WatchlistStatus } from "@/lib/db";
import { useState } from "react";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import Link from "next/link";

const STATUS_META: Record<WatchlistStatus, { label: string; icon: React.ElementType; color: string }> = {
  to_watch:   { label: "À voir",      icon: Eye,          color: "text-sky-400 bg-sky-400/10 border-sky-400/20" },
  to_request: { label: "À demander",  icon: Clock,        color: "text-amber-400 bg-amber-400/10 border-amber-400/20" },
  favorite:   { label: "Favoris",     icon: Heart,        color: "text-rose-400 bg-rose-400/10 border-rose-400/20" },
  watched:    { label: "Vus",         icon: CheckCircle2, color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" },
  abandoned:  { label: "Abandonnés",  icon: X,            color: "text-slate-400 bg-slate-400/10 border-slate-400/20" },
};

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "to_request", "favorite", "watched", "abandoned"];

function posterSrc(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE_BASE}/w342${path}`;
}

function RequestButton({ item }: { item: WatchlistItem }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  async function doRequest() {
    setState("loading");
    try {
      const jsType = item.mediaType === "movie" ? "movie" : "tv";
      const res = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: jsType, mediaId: item.tmdbId }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }
  return (
    <button
      onClick={() => state === "error" ? setState("idle") : doRequest()}
      disabled={state === "loading" || state === "done"}
      title={state === "error" ? "Échec — cliquer pour réessayer" : "Demander via Jellyseerr"}
      className={`w-full flex items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium transition-colors ${
        state === "done"  ? "bg-emerald-500/15 text-emerald-400" :
        state === "error" ? "bg-red-500/15 text-red-400 hover:bg-red-500/25" :
        "bg-sky-500/10 text-sky-400 hover:bg-sky-500/20"
      }`}
    >
      <PlusCircle size={10} />
      {state === "done" ? "Demandé ✓" : state === "loading" ? "…" : state === "error" ? "Erreur — réessayer" : "Demander"}
    </button>
  );
}

export default function WatchlistPage() {
  const [activeStatus, setActiveStatus] = useState<WatchlistStatus | "all">("all");
  const { mutate } = useSWRConfig();

  const url = activeStatus === "all" ? "/api/watchlist" : `/api/watchlist?status=${activeStatus}`;
  const { data: allData } = useSWR<{ items: WatchlistItem[] }>("/api/watchlist", fetcher);
  const { data, isLoading } = useSWR<{ items: WatchlistItem[] }>(url, fetcher);
  const { data: libMap } = useSWR<{ movieMap: Record<number, number>; seriesMap: Record<number, number> }>(
    "/api/library/map", fetcher, { revalidateOnFocus: false }
  );

  async function changeStatus(item: WatchlistItem, status: WatchlistStatus) {
    await fetch("/api/watchlist/item", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, status }),
    });
    mutate(url);
    mutate("/api/watchlist");
  }

  async function removeItem(item: WatchlistItem) {
    const res = await fetch("/api/watchlist", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbId: item.tmdbId, mediaType: item.mediaType }),
    });
    if (res.ok) {
      mutate(url);
      mutate("/api/watchlist");
    }
  }

  const items = data?.items ?? [];
  const totalCount = allData?.items.length ?? 0;

  return (
    <div>
      <PageHeader title="Ma liste" subtitle="Films et séries à suivre, voir ou demander" />

      {/* Status filter tabs */}
      <div className="mb-6 flex flex-wrap gap-2">
        <button
          onClick={() => setActiveStatus("all")}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            activeStatus === "all"
              ? "border-accent-500/40 bg-accent-500/10 text-accent-400"
              : "border-white/10 text-slate-500 hover:text-slate-300"
          }`}
        >
          Tout ({totalCount})
        </button>
        {ALL_STATUSES.map((s) => {
          const meta = STATUS_META[s];
          const Icon = meta.icon;
          return (
            <button
              key={s}
              onClick={() => setActiveStatus(s)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                activeStatus === s
                  ? `${meta.color} border-current`
                  : "border-white/10 text-slate-500 hover:text-slate-300"
              }`}
            >
              <Icon size={11} />
              {meta.label}
            </button>
          );
        })}
      </div>

      {isLoading && <LoadingState label="Chargement de la liste…" />}

      {!isLoading && items.length === 0 && (
        <EmptyState label="Aucun élément dans cette catégorie. Ajoutez des films ou séries via la recherche ou les fiches." />
      )}

      {items.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item) => {
            const statusMeta = STATUS_META[item.status];
            const StatusIcon = statusMeta.icon;
            const libraryId = item.mediaType === "movie"
              ? (item.tmdbId ? libMap?.movieMap[item.tmdbId] : undefined)
              : (item.tmdbId ? libMap?.seriesMap[item.tmdbId] : undefined);
            const libraryHref = libraryId
              ? (item.mediaType === "movie" ? `/radarr/${libraryId}` : `/sonarr/${libraryId}`)
              : null;

            return (
              <div key={item.id} className="card group relative flex flex-col overflow-hidden">
                <div className="relative">
                  <PosterImage src={posterSrc(item.posterPath)} alt={item.title} />
                  {/* Status badge */}
                  <div className={`absolute left-1.5 top-1.5 flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium backdrop-blur-sm ${statusMeta.color}`}>
                    <StatusIcon size={9} />
                    {statusMeta.label}
                  </div>
                  {/* Library link overlay */}
                  {libraryHref && (
                    <Link
                      href={libraryHref}
                      className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 group-hover:opacity-100 group-hover:bg-black/30 transition-all duration-200"
                    >
                      <span className="flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
                        <ExternalLink size={11} /> Voir la fiche
                      </span>
                    </Link>
                  )}
                  {/* Media type badge */}
                  <div className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-slate-300">
                    {item.mediaType === "movie" ? <Film size={9} /> : <Tv size={9} />}
                  </div>
                </div>

                <div className="flex flex-1 flex-col gap-1.5 p-2">
                  <div>
                    <p className="truncate text-xs font-medium text-white">{item.title}</p>
                    {item.year && <p className="text-[11px] text-slate-500">{item.year}</p>}
                  </div>

                  <div className="mt-auto space-y-1.5">
                    <div className="flex items-center gap-1">
                      <select
                        value={item.status}
                        onChange={(e) => changeStatus(item, e.target.value as WatchlistStatus)}
                        className="min-w-0 flex-1 rounded bg-slate-800 px-1.5 py-1 text-[11px] text-slate-300 outline-none ring-1 ring-white/10 hover:ring-white/20"
                        style={{ colorScheme: "dark" }}
                      >
                        {ALL_STATUSES.map((s) => (
                          <option key={s} value={s} className="bg-slate-900 text-slate-200">
                            {STATUS_META[s].label}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => removeItem(item)}
                        className="shrink-0 rounded bg-red-500/10 p-1.5 text-red-400 hover:bg-red-500/20"
                        title="Retirer de la liste"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    {item.tmdbId && !libraryId && <RequestButton item={item} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

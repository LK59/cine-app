"use client";

import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/StateViews";
import {
  Eye, Heart, X, Clock, CheckCircle2, Film, Tv, Trash2,
  PlusCircle, ExternalLink, Search, BookCheck, MessageSquare,
  ChevronDown,
} from "lucide-react";
import type { WatchlistItem, WatchlistStatus } from "@/lib/db";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import Link from "next/link";
import { createPortal } from "react-dom";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_META: Record<WatchlistStatus, {
  label: string;
  icon: React.ElementType;
  textColor: string;
  bgSolid: string;
  borderAccent: string;
}> = {
  to_watch:   { label: "À voir",     icon: Eye,          textColor: "text-sky-400",     bgSolid: "bg-sky-500",     borderAccent: "border-l-sky-400" },
  to_request: { label: "À demander", icon: Clock,        textColor: "text-amber-400",   bgSolid: "bg-amber-500",   borderAccent: "border-l-amber-400" },
  favorite:   { label: "Favoris",    icon: Heart,        textColor: "text-rose-400",    bgSolid: "bg-rose-500",    borderAccent: "border-l-rose-400" },
  watched:    { label: "Vus",        icon: CheckCircle2, textColor: "text-emerald-400", bgSolid: "bg-emerald-500", borderAccent: "border-l-emerald-400" },
  abandoned:  { label: "Abandonnés", icon: X,            textColor: "text-slate-400",   bgSolid: "bg-slate-500",   borderAccent: "border-l-slate-400" },
};

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "favorite", "watched", "to_request", "abandoned"];

type SortKey = "date" | "title" | "year";

function posterSrc(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE_BASE}/w342${path}`;
}

// ─── Note Modal ───────────────────────────────────────────────────────────────

function NoteModal({ item, onSave, onClose }: {
  item: WatchlistItem;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(item.note ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  function handleKey(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { onSave(text); onClose(); }
    if (e.key === "Escape") onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-0.5 text-sm font-semibold text-white truncate">{item.title}</p>
        <p className="mb-3 text-xs text-slate-500">Note personnelle</p>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ajoute une note…"
          rows={4}
          className="w-full resize-none rounded-xl border border-white/10 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder-slate-600 outline-none focus:border-accent-500/50"
        />
        <p className="mt-1.5 mb-3 text-[10px] text-slate-600">⌘ + Entrée pour sauvegarder</p>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-white/10 py-2 text-sm text-slate-400 hover:text-white transition-colors">
            Annuler
          </button>
          {item.note && (
            <button onClick={() => { onSave(""); onClose(); }} className="rounded-xl border border-red-500/20 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors">
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={() => { onSave(text); onClose(); }}
            className="flex-1 rounded-xl bg-accent-500 py-2 text-sm font-medium text-white hover:bg-accent-400 transition-colors"
          >
            Enregistrer
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Request Button ───────────────────────────────────────────────────────────

function RequestButton({ item }: { item: WatchlistItem }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  async function doRequest(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    setState("loading");
    try {
      const res = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: item.mediaType === "movie" ? "movie" : "tv", mediaId: item.tmdbId }),
      });
      setState(res.ok ? "done" : "error");
    } catch { setState("error"); }
  }
  return (
    <button
      onClick={doRequest}
      disabled={state === "loading" || state === "done"}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
        state === "done"  ? "bg-emerald-500/20 text-emerald-400" :
        state === "error" ? "bg-red-500/20 text-red-400" :
        "bg-white/10 text-white hover:bg-white/20"
      }`}
    >
      <PlusCircle size={11} />
      {state === "done" ? "Demandé ✓" : state === "loading" ? "…" : "Demander"}
    </button>
  );
}

// ─── Watchlist Card ───────────────────────────────────────────────────────────

function WatchlistCard({ item, libraryHref, onStatusChange, onNoteEdit, onRemove }: {
  item: WatchlistItem;
  libraryHref: string | null;
  onStatusChange: (s: WatchlistStatus) => void;
  onNoteEdit: () => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const m = STATUS_META[item.status];
  const StatusIcon = m.icon;
  const poster = posterSrc(item.posterPath);

  // Close mobile menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("touchstart", onDown); };
  }, [menuOpen]);

  return (
    <div className="group relative flex flex-col overflow-visible rounded-xl border border-white/5 bg-slate-900 shadow-lg transition-all duration-200 hover:border-white/15 hover:shadow-2xl hover:-translate-y-0.5">
      {/* Poster area */}
      <div className="relative aspect-[2/3] overflow-hidden rounded-t-xl bg-slate-800">
        {poster
          ? <img src={poster} alt={item.title} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" loading="lazy" />
          : <div className="flex h-full items-center justify-center">{item.mediaType === "movie" ? <Film size={32} className="text-slate-700" /> : <Tv size={32} className="text-slate-700" />}</div>
        }

        {/* Type pill */}
        <div className="absolute left-2 top-2 rounded-md bg-black/60 p-1 backdrop-blur-sm">
          {item.mediaType === "movie" ? <Film size={10} className="text-slate-300" /> : <Tv size={10} className="text-slate-300" />}
        </div>

        {/* Available badge */}
        {libraryHref && (
          <div className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[10px] font-bold text-white shadow-lg backdrop-blur-sm">
            <BookCheck size={9} /> Dispo
          </div>
        )}

        {/* Note dot */}
        {item.note && (
          <div className="absolute bottom-2 right-2 rounded-full bg-amber-400/90 p-1 shadow-md" title={item.note}>
            <MessageSquare size={8} className="text-slate-900" />
          </div>
        )}

        {/* Desktop hover overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 opacity-0 backdrop-blur-[2px] transition-opacity duration-200 group-hover:opacity-100 hidden md:flex">
          {/* Status quick-change row */}
          <div className="flex gap-2">
            {ALL_STATUSES.map((s) => {
              const meta = STATUS_META[s];
              const Icon = meta.icon;
              const active = item.status === s;
              return (
                <button
                  key={s}
                  onClick={(e) => { e.stopPropagation(); onStatusChange(s); }}
                  title={meta.label}
                  className={`flex h-9 w-9 items-center justify-center rounded-full border transition-all duration-150 ${
                    active
                      ? `${meta.bgSolid} border-white/30 text-white shadow-lg scale-110`
                      : "border-white/20 bg-black/40 text-white/60 hover:border-white/40 hover:bg-white/15 hover:text-white hover:scale-105"
                  }`}
                >
                  <Icon size={14} />
                </button>
              );
            })}
          </div>

          {/* Action row */}
          <div className="flex items-center gap-2">
            {libraryHref ? (
              <Link
                href={libraryHref}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/25 transition-colors"
              >
                <ExternalLink size={11} /> Voir la fiche
              </Link>
            ) : (
              <RequestButton item={item} />
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onNoteEdit(); }}
              title={item.note ? "Modifier la note" : "Ajouter une note"}
              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                item.note ? "bg-amber-400/20 text-amber-300 hover:bg-amber-400/30" : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white"
              }`}
            >
              <MessageSquare size={12} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Info strip */}
      <div className={`flex items-center gap-1.5 border-l-[3px] px-2.5 py-2 ${m.borderAccent}`}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold leading-tight text-white">{item.title}</p>
          {item.year && <p className="text-[10px] text-slate-500">{item.year}</p>}
        </div>

        {/* Mobile menu trigger */}
        <div className="relative md:hidden" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className={`flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors ${m.textColor} hover:bg-white/5`}
          >
            <StatusIcon size={9} />
            <ChevronDown size={8} className={`transition-transform ${menuOpen ? "rotate-180" : ""}`} />
          </button>

          {menuOpen && (
            <div className="absolute bottom-full right-0 z-50 mb-1 w-44 overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-2xl">
              <div className="p-1">
                {ALL_STATUSES.map((s) => {
                  const meta = STATUS_META[s];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={s}
                      onClick={() => { onStatusChange(s); setMenuOpen(false); }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                        item.status === s
                          ? `${meta.textColor} bg-white/10 font-semibold`
                          : "text-slate-400 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      <Icon size={11} /> {meta.label}
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-white/10 p-1">
                {libraryHref ? (
                  <Link
                    href={libraryHref}
                    onClick={() => setMenuOpen(false)}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-white transition-colors"
                  >
                    <ExternalLink size={11} /> Voir la fiche
                  </Link>
                ) : (
                  <div className="px-1 py-0.5">
                    <RequestButton item={item} />
                  </div>
                )}
                <button
                  onClick={() => { onNoteEdit(); setMenuOpen(false); }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                    item.note ? "text-amber-400 hover:bg-amber-400/10" : "text-slate-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <MessageSquare size={11} /> {item.note ? "Modifier la note" : "Ajouter une note"}
                </button>
                <button
                  onClick={() => { onRemove(); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={11} /> Supprimer
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-xl border border-white/5 bg-slate-900 overflow-hidden">
          <div className="aspect-[2/3] bg-slate-800" />
          <div className="p-2.5 space-y-1.5">
            <div className="h-2.5 w-3/4 rounded bg-slate-800" />
            <div className="h-2 w-1/3 rounded bg-slate-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function WatchlistPage() {
  const [activeStatus, setActiveStatus] = useState<WatchlistStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [noteItem, setNoteItem] = useState<WatchlistItem | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { mutate } = useSWRConfig();
  const { data: allData, isLoading } = useSWR<{ items: WatchlistItem[] }>("/api/watchlist", fetcher);
  const { data: libMap } = useSWR<{ movieMap: Record<number, number>; seriesMap: Record<number, number> }>(
    "/api/library/map", fetcher, { revalidateOnFocus: false }
  );

  const allItems = allData?.items ?? [];

  const getLibraryHref = useCallback((item: WatchlistItem): string | null => {
    if (!libMap) return null;
    const id = item.mediaType === "movie" ? libMap.movieMap[item.tmdbId] : libMap.seriesMap[item.tmdbId];
    if (!id) return null;
    return item.mediaType === "movie" ? `/radarr/${id}` : `/sonarr/${id}`;
  }, [libMap]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: allItems.length };
    for (const s of ALL_STATUSES) c[s] = allItems.filter((i) => i.status === s).length;
    return c;
  }, [allItems]);

  const availableCount = useMemo(() => allItems.filter((i) => getLibraryHref(i) !== null).length, [allItems, getLibraryHref]);

  const filtered = useMemo(() => {
    let items = activeStatus === "all" ? allItems : allItems.filter((i) => i.status === activeStatus);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter((i) => i.title.toLowerCase().includes(q));
    }
    return [...items].sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title, "fr");
      if (sort === "year") return (b.year ?? 0) - (a.year ?? 0);
      return b.updatedAt - a.updatedAt;
    });
  }, [allItems, activeStatus, search, sort]);

  async function changeStatus(item: WatchlistItem, status: WatchlistStatus) {
    mutate("/api/watchlist", { items: allItems.map((i) => i.id === item.id ? { ...i, status } : i) }, { revalidate: false });
    await fetch("/api/watchlist/item", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, status }),
    });
    mutate("/api/watchlist");
  }

  async function saveNote(item: WatchlistItem, note: string) {
    mutate("/api/watchlist", { items: allItems.map((i) => i.id === item.id ? { ...i, note: note || null } : i) }, { revalidate: false });
    await fetch("/api/watchlist/item", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, status: item.status, note }),
    });
    mutate("/api/watchlist");
  }

  async function removeItem(item: WatchlistItem) {
    mutate("/api/watchlist", { items: allItems.filter((i) => i.id !== item.id) }, { revalidate: false });
    await fetch("/api/watchlist", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbId: item.tmdbId, mediaType: item.mediaType }),
    });
    mutate("/api/watchlist");
  }

  return (
    <div>
      <PageHeader title="Ma liste" subtitle="Films et séries à suivre, voir ou demander" />

      {/* Stats */}
      {allItems.length > 0 && (
        <div className="mb-6 grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-white/5 bg-slate-900/80 p-3 sm:p-4">
            <p className="text-2xl font-bold text-white">{allItems.length}</p>
            <p className="mt-0.5 text-xs text-slate-500">titres en liste</p>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 sm:p-4">
            <p className="text-2xl font-bold text-emerald-400">{availableCount}</p>
            <p className="mt-0.5 text-xs text-slate-500">disponibles</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-slate-900/80 p-3 sm:p-4">
            <p className="text-2xl font-bold text-white">{counts["watched"] ?? 0}</p>
            <p className="mt-0.5 text-xs text-slate-500">vus</p>
          </div>
        </div>
      )}

      {/* Search + Sort */}
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher dans la liste…"
            className="w-full rounded-xl border border-white/10 bg-slate-900 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-600 outline-none focus:border-accent-500/50 transition-colors"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-300 outline-none cursor-pointer"
          style={{ colorScheme: "dark" }}
        >
          <option value="date">Date d&apos;ajout</option>
          <option value="title">Titre A–Z</option>
          <option value="year">Année</option>
        </select>
      </div>

      {/* Status tabs */}
      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        <button
          onClick={() => setActiveStatus("all")}
          className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            activeStatus === "all"
              ? "border-accent-500/50 bg-accent-500/10 text-accent-400"
              : "border-white/10 text-slate-500 hover:text-white"
          }`}
        >
          Tout · {counts.all}
        </button>
        {ALL_STATUSES.map((s) => {
          const meta = STATUS_META[s];
          const Icon = meta.icon;
          return (
            <button
              key={s}
              onClick={() => setActiveStatus(s)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                activeStatus === s
                  ? `${meta.textColor} border-current/50 bg-white/5`
                  : "border-white/10 text-slate-500 hover:text-white"
              }`}
            >
              <Icon size={11} />
              {meta.label}
              <span className="opacity-60">· {counts[s] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {isLoading && <SkeletonGrid />}

      {!isLoading && allItems.length === 0 && (
        <EmptyState label="Votre liste est vide. Ajoutez des films ou séries via la recherche ou les fiches détail." />
      )}

      {!isLoading && allItems.length > 0 && filtered.length === 0 && (
        <EmptyState label="Aucun résultat pour cette recherche ou ce filtre." />
      )}

      {filtered.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {filtered.map((item) => (
            <WatchlistCard
              key={item.id}
              item={item}
              libraryHref={getLibraryHref(item)}
              onStatusChange={(status) => changeStatus(item, status)}
              onNoteEdit={() => setNoteItem(item)}
              onRemove={() => removeItem(item)}
            />
          ))}
        </div>
      )}

      {/* Note modal */}
      {mounted && noteItem && (
        <NoteModal
          item={noteItem}
          onSave={(note) => saveNote(noteItem, note)}
          onClose={() => setNoteItem(null)}
        />
      )}
    </div>
  );
}

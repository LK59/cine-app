"use client";

import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/StateViews";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import {
  Eye, Heart, X, Clock, CircleCheck, Film, Tv, Trash2,
  CirclePlus, ExternalLink, Search, BookCheck, MessageSquare,
  Plus, Star, Telescope,
} from "lucide-react";
import type { WatchlistItem, WatchlistStatus } from "@/lib/db";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useRole } from "@/lib/useRole";
import { ReleaseSearchModal } from "@/components/ReleaseSearchModal";
import { useT } from "@/components/TranslationProvider";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_META: Record<WatchlistStatus, {
  labelKey: string;
  icon: React.ElementType;
  textColor: string;
  bgSolid: string;
  borderAccent: string;
}> = {
  to_watch:   { labelKey: "watchlist.statuses.toWatch",    icon: Eye,          textColor: "text-sky-400",     bgSolid: "bg-sky-500",     borderAccent: "border-l-sky-400" },
  to_request: { labelKey: "watchlist.statuses.toRequest",  icon: Clock,        textColor: "text-amber-400",   bgSolid: "bg-amber-500",   borderAccent: "border-l-amber-400" },
  favorite:   { labelKey: "watchlist.statuses.favorites",  icon: Heart,        textColor: "text-rose-400",    bgSolid: "bg-rose-500",    borderAccent: "border-l-rose-400" },
  watched:    { labelKey: "watchlist.statuses.watched",    icon: CircleCheck, textColor: "text-emerald-400", bgSolid: "bg-emerald-500", borderAccent: "border-l-emerald-400" },
  abandoned:  { labelKey: "watchlist.statuses.abandoned",  icon: X,            textColor: "text-slate-400",   bgSolid: "bg-slate-500",   borderAccent: "border-l-slate-400" },
};

const ALL_STATUSES: WatchlistStatus[] = ["to_watch", "favorite", "watched", "to_request", "abandoned"];

type SortKey = "date" | "title" | "year" | "rating";

function posterSrc(path: string | null | undefined, size = "w342"): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

// ─── Note Modal ───────────────────────────────────────────────────────────────

function NoteModal({ item, onSave, onClose }: {
  item: WatchlistItem;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(item.note ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <p className="mb-0.5 text-sm font-semibold text-white truncate">{item.title}</p>
        <p className="mb-3 text-xs text-slate-500">{t('watchlist.noteModal.title')}</p>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { onSave(text); onClose(); }
            if (e.key === "Escape") onClose();
          }}
          placeholder={t('watchlist.noteModal.placeholder')}
          rows={4}
          className="w-full resize-none rounded-xl border border-white/10 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder-slate-600 outline-none focus:border-accent-500/50"
        />
        <div className="mt-3 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-white/10 py-2 text-sm text-slate-400 hover:text-white transition-colors">{t('watchlist.noteModal.cancel')}</button>
          {item.note && (
            <button onClick={() => { onSave(""); onClose(); }} className="rounded-xl border border-red-500/20 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors">
              <Trash2 size={14} />
            </button>
          )}
          <button onClick={() => { onSave(text); onClose(); }} className="flex-1 rounded-xl bg-accent-500 py-2 text-sm font-medium text-white hover:bg-accent-400 transition-colors">
            {t('watchlist.noteModal.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Confirm Delete Modal ─────────────────────────────────────────────────────

function ConfirmDeleteModal({ title, onConfirm, onClose }: {
  title: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold text-white">{t('watchlist.confirmDelete.title')}</p>
        <p className="mt-1 truncate text-xs text-slate-400">{title}</p>
        <p className="mt-2 text-xs text-slate-500">{t('watchlist.confirmDelete.body')}</p>
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-white/10 py-2 text-sm text-slate-400 hover:text-white transition-colors">
            {t('watchlist.confirmDelete.cancel')}
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className="flex-1 rounded-xl bg-red-500 py-2 text-sm font-semibold text-white hover:bg-red-400 transition-colors"
          >
            {t('watchlist.confirmDelete.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Add to Watchlist Modal ───────────────────────────────────────────────────

type SearchResult = {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  rating: number;
  inLibrary: boolean;
};

function AddModal({ existingKeys, onClose, onAdded }: {
  existingKeys: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [type, setType] = useState<"movie" | "tv">("movie");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/discover/search?q=${encodeURIComponent(q.trim())}&type=${type}`);
        const data = await res.json();
        setResults(data.items ?? []);
      } finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [q, type]);

  async function addItem(r: SearchResult, status: WatchlistStatus) {
    const mediaType = type === "movie" ? "movie" : "series";
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdbId: r.tmdbId, mediaType, title: r.title,
        year: r.year, posterPath: r.posterPath,
        voteAverage: r.rating ?? null,
        status,
      }),
    });
    setAdded((prev) => new Set(prev).add(r.tmdbId));
    onAdded();
  }

  const typeKey = (id: number) => `${type === "movie" ? "movie" : "series"}:${id}`;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex w-full max-w-lg flex-col rounded-2xl border border-white/10 bg-slate-900 shadow-2xl" style={{ maxHeight: "80vh" }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="shrink-0 border-b border-white/10 p-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('watchlist.addModal.searchPlaceholder')}
                className="w-full rounded-xl border border-white/10 bg-slate-800 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-600 outline-none focus:border-accent-500/50"
              />
            </div>
            <button onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 text-slate-400 hover:text-white transition-colors">
              <X size={15} />
            </button>
          </div>
          <div className="flex gap-1.5">
            {([["movie", t('watchlist.addModal.tabMovies'), Film], ["tv", t('watchlist.addModal.tabSeries'), Tv]] as const).map(([tabType, label, Icon]) => (
              <button
                key={tabType}
                onClick={() => setType(tabType)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${type === tabType ? "border-accent-500/50 bg-accent-500/10 text-accent-400" : "border-white/10 text-slate-500 hover:text-white"}`}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {loading && Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex animate-pulse gap-3 rounded-xl p-2">
              <div className="w-10 shrink-0 rounded-lg bg-slate-800" style={{ aspectRatio: "2/3" }} />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3 w-2/3 rounded bg-slate-800" />
                <div className="h-2.5 w-1/4 rounded bg-slate-800" />
              </div>
            </div>
          ))}

          {!loading && q.trim().length < 2 && (
            <p className="py-10 text-center text-sm text-slate-600">{t('watchlist.addModal.minChars')}</p>
          )}
          {!loading && q.trim().length >= 2 && results.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-600">{t('watchlist.addModal.noResults', { q })}</p>
          )}

          {!loading && results.map((r) => {
            const key = typeKey(r.tmdbId);
            const inList = existingKeys.has(key) || added.has(r.tmdbId);
            return (
              <div key={r.tmdbId} className="flex gap-3 rounded-xl p-2 transition-colors hover:bg-white/5">
                <div className="w-10 shrink-0 overflow-hidden rounded-lg bg-slate-800" style={{ aspectRatio: "2/3" }}>
                  {r.posterPath
                    ? <img src={`${TMDB_IMAGE_BASE}/w92${r.posterPath}`} alt="" className="h-full w-full object-cover" />
                    : <div className="flex h-full items-center justify-center">{type === "movie" ? <Film size={14} className="text-slate-700" /> : <Tv size={14} className="text-slate-700" />}</div>
                  }
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">{r.title}</p>
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-slate-500">{r.year ?? "—"}</p>
                    {r.rating > 0 && (
                      <span className="flex items-center gap-0.5 text-[10px] text-amber-400">
                        <Star size={9} className="fill-current" /> {r.rating.toFixed(1)}
                      </span>
                    )}
                    {r.inLibrary && (
                      <span className="flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400">
                        <BookCheck size={8} /> {t('watchlist.addModal.available')}
                      </span>
                    )}
                  </div>
                  {inList ? (
                    <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-accent-500/10 px-2 py-0.5 text-[10px] font-medium text-accent-400">
                      ✓ {t('watchlist.addModal.alreadyInList')}
                    </span>
                  ) : (
                    <div className="mt-1.5 flex items-center gap-1">
                      <span className="mr-0.5 text-[10px] text-slate-600">{t('watchlist.addModal.addLabel')}</span>
                      {ALL_STATUSES.map((s) => {
                        const m = STATUS_META[s];
                        const Icon = m.icon;
                        return (
                          <button
                            key={s}
                            onClick={() => addItem(r, s)}
                            title={t(m.labelKey)}
                            className={`flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-black/30 ${m.textColor} transition-colors hover:bg-white/10 hover:border-white/30`}
                          >
                            <Icon size={10} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Request Button (desktop overlay) ────────────────────────────────────────

function RequestButton({ item }: { item: WatchlistItem }) {
  const t = useT();
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
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
        state === "done" ? "bg-emerald-500/20 text-emerald-400" :
        state === "error" ? "bg-red-500/20 text-red-400" :
        "bg-white/10 text-white hover:bg-white/20"
      }`}
    >
      <CirclePlus size={9} />
      {state === "done" ? t('common.requested') : state === "loading" ? "…" : t('common.request')}
    </button>
  );
}

// ─── Watchlist Card ───────────────────────────────────────────────────────────

function WatchlistCard({ item, libraryHref, isAvailable, imdbRating, onStatusChange, onNoteEdit, onRemove }: {
  item: WatchlistItem;
  libraryHref: string | null;
  isAvailable: boolean;
  imdbRating: string | null;
  onStatusChange: (s: WatchlistStatus) => void;
  onNoteEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { role } = useRole();
  const isAdmin = role === "admin";
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [addingSearch, setAddingSearch] = useState(false);
  const [releaseModal, setReleaseModal] = useState<{ title: string; searchEndpoint: string; grabEndpoint: string } | null>(null);
  const m = STATUS_META[item.status];
  const poster = posterSrc(item.posterPath);

  async function doInteractiveSearch(e?: React.MouseEvent) {
    e?.stopPropagation();
    setAddingSearch(true);
    try {
      const res = await fetch("/api/discover/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: item.mediaType, tmdbId: item.tmdbId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      if (item.mediaType === "movie" && data.radarrId) {
        setReleaseModal({ title: item.title, searchEndpoint: `/api/radarr/movies/${data.radarrId}/releases`, grabEndpoint: `/api/radarr/releases` });
      } else if (item.mediaType === "series" && data.sonarrId) {
        setReleaseModal({ title: item.title, searchEndpoint: `/api/sonarr/series/${data.sonarrId}/releases`, grabEndpoint: `/api/sonarr/releases` });
      }
    } finally {
      setAddingSearch(false);
    }
  }

  // Build ActionSheet actions for mobile
  const sheetActions: SheetAction[] = [
    // Status section
    ...ALL_STATUSES.map((s) => {
      const meta = STATUS_META[s];
      const Icon = meta.icon;
      const isActive = item.status === s;
      return {
        label: t(meta.labelKey),
        icon: <Icon size={16} />,
        onClick: () => onStatusChange(s),
        variant: (isActive ? "accent" : "default") as "accent" | "default",
        disabled: isActive,
      };
    }),
    // Library or request
    ...(libraryHref
      ? [{ label: t('common.viewSheet'), icon: <ExternalLink size={16} />, onClick: () => { window.location.href = libraryHref; } }]
      : [{ label: t('common.request'), icon: <CirclePlus size={16} />, onClick: async () => {
          await fetch("/api/jellyseerr/requests", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mediaType: item.mediaType === "movie" ? "movie" : "tv", mediaId: item.tmdbId }),
          });
        }}]
    ),
    { label: item.note ? t('watchlist.editNote') : t('watchlist.addNote'), icon: <MessageSquare size={16} />, onClick: onNoteEdit },
    ...(isAdmin && !isAvailable ? [{ label: t('common.interactiveSearch'), icon: <Telescope size={16} />, onClick: () => doInteractiveSearch(), disabled: addingSearch }] : []),
    { label: t('watchlist.removeFromList'), icon: <Trash2 size={16} />, onClick: () => setPendingDelete(true), variant: "danger" as const },
  ];

  return (
    <>
      <div className="group flex flex-col overflow-hidden rounded-xl border border-white/5 bg-slate-900 shadow-lg transition-all duration-200 hover:border-white/15 hover:shadow-2xl hover:-translate-y-0.5">
        {/* Poster */}
        <div
          className="relative aspect-[2/3] overflow-hidden rounded-t-xl bg-slate-800 cursor-pointer select-none"
          onClick={() => {
            // Mobile (touch): open ActionSheet; desktop: hover overlay handles it
            if (window.matchMedia("(pointer: coarse)").matches) setSheetOpen(true);
          }}
        >
          {poster
            ? <img src={poster} alt={item.title} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" loading="lazy" />
            : <div className="flex h-full items-center justify-center">{item.mediaType === "movie" ? <Film size={28} className="text-slate-700" /> : <Tv size={28} className="text-slate-700" />}</div>
          }

          {/* Type badge */}
          <div className="pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-black/60 p-1 backdrop-blur-sm">
            {item.mediaType === "movie" ? <Film size={9} className="text-slate-300" /> : <Tv size={9} className="text-slate-300" />}
          </div>

          {/* Library badge */}
          {libraryHref && isAvailable && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <BookCheck size={8} /> {t('common.available')}
            </div>
          )}
          {libraryHref && !isAvailable && (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
              <Clock size={8} /> {t('common.pending')}
            </div>
          )}

          {/* IMDb rating badge — always visible */}
          {imdbRating && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-bold text-amber-400 backdrop-blur-sm">
              <Star size={7} className="fill-current" /> {imdbRating}
            </div>
          )}

          {/* Note dot */}
          {item.note && (
            <div className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-amber-400/90 p-1">
              <MessageSquare size={7} className="text-slate-900" />
            </div>
          )}

          {/* Desktop hover overlay */}
          <div className="absolute inset-0 hidden flex-col items-center justify-center gap-2 bg-black/88 backdrop-blur-sm opacity-0 transition-opacity duration-200 group-hover:opacity-100 md:flex">
            <div className="flex gap-1">
              {ALL_STATUSES.map((s) => {
                const meta = STATUS_META[s];
                const Icon = meta.icon;
                const active = item.status === s;
                return (
                  <button
                    key={s}
                    onClick={(e) => { e.stopPropagation(); onStatusChange(s); }}
                    title={t(meta.labelKey)}
                    className={`flex h-6 w-6 items-center justify-center rounded-full border transition-all duration-150 ${
                      active
                        ? `${meta.bgSolid} border-white/30 text-white shadow-md scale-110`
                        : "border-white/15 bg-black/40 text-white/60 hover:border-white/30 hover:bg-white/15 hover:text-white hover:scale-105"
                    }`}
                  >
                    <Icon size={10} />
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1">
              {libraryHref ? (
                <Link href={libraryHref} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 rounded-lg bg-white/15 px-2 py-1 text-[10px] font-medium text-white hover:bg-white/25 transition-colors">
                  <ExternalLink size={9} /> {t('common.viewSheet')}
                </Link>
              ) : (
                <RequestButton item={item} />
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onNoteEdit(); }}
                title={item.note ? t('watchlist.editNote') : t('watchlist.addNote')}
                className={`flex h-6 w-6 items-center justify-center rounded-lg transition-colors ${item.note ? "bg-amber-400/20 text-amber-300 hover:bg-amber-400/30" : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white"}`}
              >
                <MessageSquare size={9} />
              </button>
              {isAdmin && !isAvailable && (
                <button
                  onClick={(e) => doInteractiveSearch(e)}
                  disabled={addingSearch}
                  title={t('common.interactiveSearch')}
                  className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40"
                >
                  <Telescope size={9} />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); setPendingDelete(true); }}
                className="flex h-6 w-6 items-center justify-center rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
              >
                <Trash2 size={9} />
              </button>
            </div>
          </div>
        </div>

        {/* Info strip */}
        <div className={`flex items-center border-l-[3px] px-2 py-1.5 ${m.borderAccent}`}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold leading-tight text-white">{item.title}</p>
            {item.year && <p className="text-[9px] text-slate-500">{item.year}</p>}
          </div>
        </div>
      </div>

      {/* Mobile bottom sheet */}
      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={item.title}
        subtitle={`${item.year ?? ""} · ${item.mediaType === "movie" ? t('common.film') : t('common.series')}${imdbRating ? ` · IMDb ${imdbRating}` : ""}`}
        poster={poster}
        actions={sheetActions}
      />

      {/* Delete confirmation */}
      {pendingDelete && (
        <ConfirmDeleteModal
          title={item.title}
          onConfirm={onRemove}
          onClose={() => setPendingDelete(false)}
        />
      )}

      {/* Interactive search modal */}
      {releaseModal && (
        <ReleaseSearchModal
          title={releaseModal.title}
          searchEndpoint={releaseModal.searchEndpoint}
          grabEndpoint={releaseModal.grabEndpoint}
          onClose={() => setReleaseModal(null)}
        />
      )}
    </>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="animate-pulse overflow-hidden rounded-xl border border-white/5 bg-slate-900">
          <div className="aspect-[2/3] bg-slate-800" />
          <div className="space-y-1.5 p-2">
            <div className="h-2 w-3/4 rounded bg-slate-800" />
            <div className="h-2 w-1/3 rounded bg-slate-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function WatchlistPage() {
  const t = useT();
  const [activeStatus, setActiveStatus] = useState<WatchlistStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [noteItem, setNoteItem] = useState<WatchlistItem | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { mutate } = useSWRConfig();
  const { data: allData, isLoading } = useSWR<{ items: WatchlistItem[] }>("/api/watchlist", fetcher);
  const { data: libMap } = useSWR<{
    movieMap: Record<number, number>;
    seriesMap: Record<number, number>;
    hasFileMovieIds: number[];
    hasFileSeriesIds: number[];
  }>("/api/library/map", fetcher, { revalidateOnFocus: false });

  const allItems = allData?.items ?? [];

  // Build IMDb ratings query once the list is loaded
  const ratingsKey = useMemo(() => {
    if (!allItems.length) return null;
    const q = allItems.map((i) => `${i.mediaType}:${i.tmdbId}`).join(",");
    return `/api/watchlist/ratings?items=${q}`;
  }, [allItems]);

  const { data: ratingsMap } = useSWR<Record<string, string | null>>(
    ratingsKey, fetcher, { revalidateOnFocus: false }
  );

  const getLibraryHref = useCallback((item: WatchlistItem): string | null => {
    if (!libMap) return null;
    const id = item.mediaType === "movie" ? libMap.movieMap[item.tmdbId] : libMap.seriesMap[item.tmdbId];
    if (!id) return null;
    return item.mediaType === "movie" ? `/radarr/${id}` : `/sonarr/${id}`;
  }, [libMap]);

  const getIsAvailable = useCallback((item: WatchlistItem): boolean => {
    if (!libMap) return false;
    if (item.mediaType === "movie") return libMap.hasFileMovieIds.includes(item.tmdbId);
    return libMap.hasFileSeriesIds.includes(item.tmdbId);
  }, [libMap]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: allItems.length };
    for (const s of ALL_STATUSES) c[s] = allItems.filter((i) => i.status === s).length;
    return c;
  }, [allItems]);

  const availableCount = useMemo(() => allItems.filter((i) => getLibraryHref(i) !== null).length, [allItems, getLibraryHref]);

  const existingKeys = useMemo(() => new Set(allItems.map((i) => `${i.mediaType}:${i.tmdbId}`)), [allItems]);

  const filtered = useMemo(() => {
    let items = activeStatus === "all" ? allItems : allItems.filter((i) => i.status === activeStatus);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter((i) => i.title.toLowerCase().includes(q));
    }
    return [...items].sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title, "fr");
      if (sort === "year") return (b.year ?? 0) - (a.year ?? 0);
      if (sort === "rating") return (b.voteAverage ?? 0) - (a.voteAverage ?? 0);
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
      <PageHeader title={t('watchlist.pageTitle')} subtitle={t('watchlist.subtitle')} />

      {/* Stats */}
      {allItems.length > 0 && (
        <div className="mb-6 grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-white/5 bg-slate-900/80 p-3 sm:p-4">
            <p className="text-2xl font-bold text-white">{allItems.length}</p>
            <p className="mt-0.5 text-xs text-slate-500">{t('watchlist.stats.total')}</p>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 sm:p-4">
            <p className="text-2xl font-bold text-emerald-400">{availableCount}</p>
            <p className="mt-0.5 text-xs text-slate-500">{t('watchlist.stats.available')}</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-slate-900/80 p-3 sm:p-4">
            <p className="text-2xl font-bold text-white">{counts["watched"] ?? 0}</p>
            <p className="mt-0.5 text-xs text-slate-500">{t('watchlist.stats.watched')}</p>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('watchlist.searchPlaceholder')}
            className="w-full rounded-xl border border-white/10 bg-slate-900 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-600 outline-none transition-colors focus:border-accent-500/50"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-300 outline-none"
          style={{ colorScheme: "dark" }}
        >
          <option value="date">{t('watchlist.sortDate')}</option>
          <option value="title">{t('common.sortTitleAZ')}</option>
          <option value="year">{t('common.sortYear')}</option>
          <option value="rating">{t('watchlist.sortRating')}</option>
        </select>
        <button
          onClick={() => setShowAdd(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm font-medium text-accent-400 transition-colors hover:bg-accent-500/20"
        >
          <Plus size={14} /> <span className="hidden sm:inline">{t('common.add')}</span>
        </button>
      </div>

      {/* Status tabs */}
      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        <button
          onClick={() => setActiveStatus("all")}
          className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            activeStatus === "all" ? "border-accent-500/50 bg-accent-500/10 text-accent-400" : "border-white/10 text-slate-500 hover:text-white"
          }`}
        >
          {t('watchlist.tabAll')} · {counts.all}
        </button>
        {ALL_STATUSES.map((s) => {
          const meta = STATUS_META[s];
          const Icon = meta.icon;
          return (
            <button
              key={s}
              onClick={() => setActiveStatus(s)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                activeStatus === s ? `${meta.textColor} border-current/50 bg-white/5` : "border-white/10 text-slate-500 hover:text-white"
              }`}
            >
              <Icon size={11} /> {t(meta.labelKey)} <span className="opacity-60">· {counts[s] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {isLoading && <SkeletonGrid />}

      {!isLoading && allItems.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-slate-500">{t('watchlist.empty')}</p>
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 rounded-xl bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-400 transition-colors">
            <Plus size={14} /> {t('watchlist.addTitle')}
          </button>
        </div>
      )}

      {!isLoading && allItems.length > 0 && filtered.length === 0 && (
        <EmptyState label={t('watchlist.emptyFilter')} />
      )}

      {filtered.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {filtered.map((item) => (
            <WatchlistCard
              key={item.id}
              item={item}
              libraryHref={getLibraryHref(item)}
              isAvailable={getIsAvailable(item)}
              imdbRating={ratingsMap?.[`${item.mediaType}:${item.tmdbId}`] ?? null}
              onStatusChange={(status) => changeStatus(item, status)}
              onNoteEdit={() => setNoteItem(item)}
              onRemove={() => removeItem(item)}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {mounted && noteItem && (
        <NoteModal item={noteItem} onSave={(note) => saveNote(noteItem, note)} onClose={() => setNoteItem(null)} />
      )}
      {mounted && showAdd && (
        <AddModal existingKeys={existingKeys} onClose={() => setShowAdd(false)} onAdded={() => mutate("/api/watchlist")} />
      )}
    </div>
  );
}

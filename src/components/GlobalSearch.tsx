"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import {
  Search, Film, Tv, X, ExternalLink, Send, Bookmark,
  User, Star, Loader2, BookmarkCheck,
} from "lucide-react";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import type { SearchResponse, UnifiedSearchResult, PersonResult } from "@/app/api/search/route";
import { posterUrl } from "@/lib/images";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { useSWRConfig } from "swr";

// ─── Fuzzy matching ───────────────────────────────────────────────────────────

function norm(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").trim();
}

function fuzzyScore(title: string, query: string): number {
  const t = norm(title);
  const q = norm(query);
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 70;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 50;
  if (words.some((w) => t.startsWith(w))) return 30;
  return 0;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalResult {
  id: number;
  title: string;
  year: number;
  poster: string | null;
  href: string;
  type: "movie" | "series";
  score: number;
  tmdbId: number;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    radarr:     "bg-accent-600/15 text-accent-400",
    sonarr:     "bg-sky-600/15 text-sky-400",
    tmdb:       "bg-purple-600/15 text-purple-400",
    jellyfin:   "bg-emerald-600/15 text-emerald-400",
    jellyseerr: "bg-teal-600/15 text-teal-400",
  };
  const labels: Record<string, string> = {
    radarr: "Radarr", sonarr: "Sonarr", tmdb: "TMDb",
    jellyfin: "Jellyfin", jellyseerr: "Jellyseerr",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${colors[source] ?? "bg-white/10 text-slate-400"}`}>
      {labels[source] ?? source}
    </span>
  );
}

function ResultPoster({ src, type }: { src: string | null; type: "movie" | "series" }) {
  return (
    <div className="h-10 w-7 shrink-0 overflow-hidden rounded bg-slate-800">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : type === "movie" ? (
        <div className="flex h-full items-center justify-center"><Film size={12} className="text-slate-600" /></div>
      ) : (
        <div className="flex h-full items-center justify-center"><Tv size={12} className="text-slate-600" /></div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [requesting, setRequesting] = useState<number | null>(null);
  const [watchlisted, setWatchlisted] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { mutate } = useSWRConfig();

  // Debounce query for API call
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Preload library data
  const { data: movies } = useSWR<RadarrMovie[]>("/api/radarr/movies", fetcher);
  const { data: series } = useSWR<SonarrSeries[]>("/api/sonarr/series", fetcher);

  // Remote search (TMDb + persons) — only fire when query ≥ 2 chars
  const { data: remoteData, isLoading: remoteLoading } = useSWR<SearchResponse>(
    open && debouncedQuery.length >= 2
      ? `/api/search?q=${encodeURIComponent(debouncedQuery)}`
      : null,
    fetcher
  );

  // ── Keyboard shortcut + custom event trigger (for mobile) ──
  useEffect(() => {
    function keyHandler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setOpen((p) => !p); }
      if (e.key === "Escape") setOpen(false);
    }
    function openHandler() { setOpen(true); }
    document.addEventListener("keydown", keyHandler);
    window.addEventListener("open-search", openHandler);
    return () => {
      document.removeEventListener("keydown", keyHandler);
      window.removeEventListener("open-search", openHandler);
    };
  }, []);

  useEffect(() => {
    if (open) { setQuery(""); setCursor(0); setDebouncedQuery(""); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [open]);

  // ── Local fuzzy results ──
  const localResults: LocalResult[] = useMemo(() => {
    const term = query.trim();
    if (term.length < 1) return [];
    const movieResults: LocalResult[] = (movies ?? [])
      .map((m) => ({ ...m, score: fuzzyScore(m.title, term), poster: posterUrl(m.images), href: `/radarr/${m.id}`, type: "movie" as const, tmdbId: m.tmdbId }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const seriesResults: LocalResult[] = (series ?? [])
      .map((s) => ({ ...s, score: fuzzyScore(s.title, term), poster: posterUrl(s.images), href: `/sonarr/${s.id}`, type: "series" as const, tmdbId: s.tmdbId ?? 0 }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return [...movieResults, ...seriesResults].sort((a, b) => b.score - a.score).slice(0, 8);
  }, [query, movies, series]);

  // ── TMDb results not in library ──
  const tmdbResults: UnifiedSearchResult[] = remoteData?.tmdb ?? [];
  const persons: PersonResult[] = remoteData?.persons ?? [];

  // Total navigable results
  const allResults = [...localResults, ...tmdbResults, ...persons];

  function navigate(href: string) { setOpen(false); router.push(href); }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, allResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") {
      const r = allResults[cursor];
      if (!r) return;
      if ("href" in r) navigate((r as LocalResult).href);
    }
  }

  async function requestMedia(result: UnifiedSearchResult) {
    if (requesting) return;
    setRequesting(result.tmdbId);
    try {
      await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: result.type === "movie" ? "movie" : "tv", mediaId: result.tmdbId }),
      });
    } finally {
      setRequesting(null);
    }
  }

  async function toggleWatchlist(result: UnifiedSearchResult | LocalResult) {
    const key = `${result.type}:${result.tmdbId}`;
    const inList = watchlisted.has(key);
    const title = "title" in result ? result.title : "";
    const year = "year" in result ? result.year : undefined;
    const poster = "posterPath" in result ? (result as UnifiedSearchResult).posterPath : ("poster" in result ? (result as LocalResult).poster : null);

    if (inList) {
      await fetch("/api/watchlist", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tmdbId: result.tmdbId, mediaType: result.type }) });
      setWatchlisted((s) => { const n = new Set(s); n.delete(key); return n; });
    } else {
      await fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaType: result.type, tmdbId: result.tmdbId, title, year, posterPath: poster }) });
      setWatchlisted((s) => new Set([...s, key]));
    }
    mutate("/api/watchlist");
  }

  if (!open) return null;

  const showEmpty = query.length >= 2 && !remoteLoading && localResults.length === 0 && tmdbResults.length === 0 && persons.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" />

      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Search size={18} className="shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Film, série, acteur, réalisateur…"
            className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 outline-none"
          />
          {remoteLoading && <Loader2 size={14} className="shrink-0 animate-spin text-slate-500" />}
          <button onClick={() => setOpen(false)} className="shrink-0 text-slate-500 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {/* ── Library results ── */}
          {localResults.length > 0 && (
            <div>
              <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Dans votre bibliothèque</p>
              {localResults.map((r, i) => {
                const isActive = i === cursor;
                const wKey = `${r.type}:${r.tmdbId}`;
                const inList = watchlisted.has(wKey);
                return (
                  <div
                    key={`local-${r.type}-${r.id}`}
                    className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${isActive ? "bg-white/10" : "hover:bg-white/5"}`}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <ResultPoster src={r.poster} type={r.type} />
                    <div className="min-w-0 flex-1">
                      <button className="block truncate text-left text-sm font-medium text-white hover:text-accent-400" onClick={() => navigate(r.href)}>
                        {r.title}
                      </button>
                      <p className="text-xs text-slate-500">{r.year}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <SourceBadge source={r.type === "movie" ? "radarr" : "sonarr"} />
                      <button
                        onClick={() => navigate(r.href)}
                        className="rounded bg-white/5 p-1.5 text-slate-400 hover:bg-white/10"
                        title="Voir la fiche"
                      ><Film size={12} /></button>
                      <button
                        onClick={() => toggleWatchlist(r)}
                        className={`rounded p-1.5 transition-colors ${inList ? "bg-accent-500/20 text-accent-400" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}
                        title={inList ? "Retirer de la liste" : "Ajouter à la liste"}
                      >
                        {inList ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Persons ── */}
          {persons.length > 0 && (
            <div>
              <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Personnes</p>
              {persons.map((p, i) => {
                const idx = localResults.length + i;
                const isVip = p.id === 3247402 && process.env.NEXT_PUBLIC_CLARA_GALLERY_ENABLED !== "false";
                return (
                  <button
                    key={`person-${p.id}`}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === cursor ? "bg-white/10" : "hover:bg-white/5"}`}
                    onMouseEnter={() => setCursor(idx)}
                    onClick={() => { setOpen(false); router.push(`/person/${p.id}`); }}
                  >
                    <div className={`h-10 w-10 shrink-0 overflow-hidden rounded-full bg-slate-800 ${isVip ? "ring-2 ring-yellow-400 ring-offset-1 ring-offset-slate-900 shadow-[0_0_8px_rgba(250,204,21,0.4)]" : ""}`}>
                      {p.profilePath
                        ? <img src={p.profilePath} alt={p.name} className="h-full w-full object-cover" />
                        : <div className="flex h-full items-center justify-center"><User size={14} className="text-slate-600" /></div>
                      }
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-sm font-medium ${isVip ? "text-yellow-400" : "text-white"}`}>{p.name}</p>
                      <p className="truncate text-xs text-slate-500">{p.department}{p.knownFor.length > 0 ? ` · ${p.knownFor.join(", ")}` : ""}</p>
                    </div>
                    <User size={12} className={`shrink-0 ${isVip ? "text-yellow-400" : "text-slate-500"}`} />
                  </button>
                );
              })}
            </div>
          )}

          {/* ── TMDb results (not in library) ── */}
          {tmdbResults.length > 0 && (
            <div>
              <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Pas dans la bibliothèque
              </p>
              {tmdbResults.slice(0, 6).map((r, i) => {
                const idx = localResults.length + persons.length + i;
                const isActive = idx === cursor;
                const wKey = `${r.type}:${r.tmdbId}`;
                const inList = watchlisted.has(wKey);
                const isRequesting = requesting === r.tmdbId;
                return (
                  <div
                    key={`tmdb-${r.type}-${r.tmdbId}`}
                    className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${isActive ? "bg-white/10" : "hover:bg-white/5"}`}
                    onMouseEnter={() => setCursor(idx)}
                  >
                    <ResultPoster src={r.posterPath} type={r.type} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{r.title}</p>
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        {r.year && <span>{r.year}</span>}
                        {r.rating > 0 && (
                          <span className="flex items-center gap-0.5">
                            <Star size={9} className="text-amber-400" />
                            {r.rating.toFixed(1)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <SourceBadge source="tmdb" />
                      <button
                        onClick={() => requestMedia(r)}
                        disabled={isRequesting}
                        className="flex items-center gap-1 rounded bg-accent-500/20 px-2 py-1 text-[11px] text-accent-400 hover:bg-accent-500/30 disabled:opacity-50"
                        title="Demander via Jellyseerr"
                      >
                        <Send size={10} />
                        {isRequesting ? "…" : "Demander"}
                      </button>
                      <button
                        onClick={() => toggleWatchlist(r)}
                        className={`rounded p-1.5 transition-colors ${inList ? "bg-accent-500/20 text-accent-400" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}
                        title={inList ? "Retirer de la liste" : "Ajouter à la liste"}
                      >
                        {inList ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {showEmpty && (
            <p className="px-4 py-6 text-center text-sm text-slate-500">Aucun résultat pour « {query} »</p>
          )}

          {!query && (
            <div className="hidden md:flex items-center justify-between px-4 py-3 text-xs text-slate-500">
              <span>↑↓ naviguer · Entrée sélectionner</span>
              <span><kbd className="rounded bg-white/10 px-1.5 py-0.5">⌘K</kbd> ouvrir/fermer</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import useSWRImmutable from "swr/immutable";
import { fetcher } from "@/lib/swr";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { Toggle } from "@/components/Toggle";
import dynamic from "next/dynamic";
const ReleaseSearchModal = dynamic(() => import("@/components/ReleaseSearchModal").then((m) => m.ReleaseSearchModal), { ssr: false });
const MediaInfoModal = dynamic(() => import("@/components/MediaInfoModal").then((m) => m.MediaInfoModal), { ssr: false });
const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });
const ActorModal = dynamic(() => import("@/components/ActorModal").then((m) => m.ActorModal), { ssr: false });
const CollectionModal = dynamic(() => import("@/components/CollectionModal").then((m) => m.CollectionModal), { ssr: false });
import { Collapsible } from "@/components/Collapsible";
import { haptic } from "@/lib/haptic";
import { useToast } from "@/components/Toast";
import {
  ArrowLeft,
  Film,
  Search,
  HardDrive,
  Star,
  Download,
  Captions,
  Mic2,
  Info,
  Trash2,
  Eye,
  EyeOff,
  ExternalLink,
  Send,
  PlayCircle,
} from "lucide-react";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { JellyfinItem } from "@/lib/clients/jellyfin";
import { posterUrl } from "@/lib/images";
import { useRole } from "@/lib/useRole";
import { useT } from "@/components/TranslationProvider";
import { WatchlistButton } from "@/components/WatchlistButton";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { MediaRatings } from "@/components/MediaRatings";
import { SimilarMedia } from "@/components/SimilarMedia";
import { ErrorBoundary } from "@/components/ErrorBoundary";

interface MovieInfo {
  trailerKey: string | null;
  tmdb: {
    overview: string;
    tagline?: string;
    genres: string[];
    runtime: number | null;
    backdropUrl: string | null;
    cast: { tmdbId: number; name: string; character: string; photoUrl: string | null }[];
    collection: { id: number; name: string } | null;
  } | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  subtitles: { name: string; code2: string; forced: boolean; hi: boolean }[];
  audioLanguages: { name: string; code2: string }[];
  activeDownload: {
    title: string;
    status: string;
    trackedDownloadStatus: string;
    size: number;
    sizeleft: number;
    indexer: string;
  } | null;
}

function poster(movie: RadarrMovie) {
  return posterUrl(movie.images, "full");
}

import { fmtSize as formatBytes } from "@/lib/format";

export default function RadarrMovieDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { isGuest, jfId } = useRole();
  const toast = useToast();
  const t = useT();
  const [selectedActor, setSelectedActor] = useState<{ tmdbId: number; name: string; photoUrl: string | null } | null>(null);
  const [showCollection, setShowCollection] = useState(false);

  const movieKey = `/api/radarr/movies/${id}`;
  const { data: movie, error, isLoading } = useSWR<RadarrMovie>(movieKey, fetcher);
  const { data: info } = useSWR<MovieInfo>(`/api/radarr/movies/${id}/info`, fetcher);
  const { data: meta } = useSWRImmutable<{ qualityProfiles: { id: number; name: string }[]; rootFolders: { id: number; path: string }[] }>(
    "/api/radarr/meta",
    fetcher
  );
  const { data: jfData, mutate: mutateJf } = useSWR<{ item: JellyfinItem | null }>(
    movie
      ? `/api/jellyfin/items?tmdbId=${movie.tmdbId ?? 0}&type=Movie&title=${encodeURIComponent(movie.title)}&year=${movie.year ?? ""}${movie.imdbId ? `&imdbId=${movie.imdbId}` : ""}`
      : null,
    fetcher
  );

  const { data: jsData, mutate: mutateJs } = useSWR<{ status: number }>(
    movie?.tmdbId ? `/api/jellyseerr/media?tmdbId=${movie.tmdbId}&type=movie` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const [qualityProfileId, setQualityProfileId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showNfo, setShowNfo] = useState(false);
  const [deletingFile, setDeletingFile] = useState(false);
  const [deletingFromRadarr, setDeletingFromRadarr] = useState(false);
  const [confirmModal, setConfirmModal] = useState<null | "file" | "radarr">(null);
  const [togglingWatched, setTogglingWatched] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const [activeTab, setActiveTab] = useState<"infos" | "casting" | "fichier">("infos");

  useEffect(() => {
    if (movie) setQualityProfileId(movie.qualityProfileId);
  }, [movie]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (e.key === "f") {
        (document.querySelector('button[title="Ajouter à la liste"],button[title="Retirer de la liste"]') as HTMLButtonElement)?.click();
      }
      if (e.key === "1") setActiveTab("infos");
      if (e.key === "2") setActiveTab("casting");
      if (e.key === "3") setActiveTab("fichier");
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  async function save(payload: Partial<RadarrMovie>) {
    if (!movie) return;
    setSaving(true);
    try {
      await fetch(movieKey, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...movie, ...payload }),
      });
      mutate(movieKey);
      toast.success(t('radarr.saveSuccess'));
    } catch {
      toast.error(t('radarr.saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function deleteFile() {
    setDeletingFile(true);
    try {
      const res = await fetch(`/api/radarr/movies/${id}/file`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      mutate(movieKey);
      toast.success(t('radarr.deleteFileSuccess'));
    } catch {
      toast.error(t('radarr.deleteFileError'));
    } finally {
      setDeletingFile(false);
    }
  }

  async function deleteFromRadarr() {
    setDeletingFromRadarr(true);
    try {
      const res = await fetch(`/api/radarr/movies/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      await fetch("/api/cache/invalidate", { method: "POST" });
      toast.success(t('radarr.deleteSuccess', { title: movie?.title ?? '' }));
      router.back();
    } catch {
      toast.error(t('radarr.deleteFileError'));
      setDeletingFromRadarr(false);
    }
  }

  async function toggleWatched() {
    const jfItem = jfData?.item;
    if (!jfItem) return;
    const newPlayed = !jfItem.UserData?.Played;
    setTogglingWatched(true);
    // Optimistic flip
    mutateJf({ item: { ...jfItem, UserData: { PlayCount: 0, ...jfItem.UserData, Played: newPlayed } } }, { revalidate: false });
    try {
      const res = await fetch("/api/jellyfin/played", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: jfItem.Id, played: newPlayed }),
      });
      if (!res.ok) throw new Error();
      mutateJf();
      toast.success(newPlayed ? t('radarr.watchedSuccess') : t('radarr.unwatchedSuccess'));
    } catch {
      mutateJf(); // rollback
      toast.error(t('radarr.watchedError'));
    } finally {
      setTogglingWatched(false);
    }
  }

  async function requestMovie() {
    if (!movie?.tmdbId) return;
    setRequesting(true);
    try {
      // Try Jellyseerr first — it relays to Radarr and tracks the request
      const jsRes = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: "movie", mediaId: movie.tmdbId }),
      });
      if (!jsRes.ok) {
        // Fallback: trigger Radarr search directly if Jellyseerr unavailable
        const searchRes = await fetch(`/api/radarr/movies/${id}/search`, { method: "POST" });
        if (!searchRes.ok) throw new Error();
      }
      mutateJs();
      // Bust server-side library cache so lists reflect the new state
      await fetch("/api/cache/invalidate", { method: "POST" });
      haptic();
      toast.success(t('radarr.requestSuccess', { title: movie.title }));
    } catch {
      toast.error(t('radarr.requestError'));
    } finally {
      setRequesting(false);
    }
  }

  if (isLoading) return <LoadingState />;
  if (error || !movie) return <ErrorState message={error?.message || t('radarr.movieNotFound')} />;

  const overview = info?.tmdb?.overview || movie.overview;
  const backdrop = info?.tmdb?.backdropUrl;
  const downloadProgress = info?.activeDownload
    ? Math.round(
        ((info.activeDownload.size - info.activeDownload.sizeleft) / info.activeDownload.size) * 100
      )
    : 0;

  const jfItem = jfData?.item;
  const isWatched = jfItem?.UserData?.Played ?? false;
  const isNotReleased = movie.status === "inCinemas" || movie.status === "announced";
  // Show "Demander" only when: not already filed/downloading, and Jellyseerr hasn't picked it up yet
  const canRequest = !movie.hasFile && !info?.activeDownload && jsData?.status === 1;

  return (
    <div className="relative -mx-4 -mt-4 sm:-mx-6 sm:-mt-6 md:-mx-8 md:-mt-6">

      {/* ── Backdrop — natural 16:9 ratio, absolute so it never clips ── */}
      {backdrop && (
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video">
          {/* The image fades out via its own alpha mask (not a solid-color overlay) so
              what shows through underneath is the page's real background — including its
              radial accent glows — instead of an approximated flat color that never quite
              matches and leaves a visible seam. Fully hidden by 72% height, well before
              the content cards at any screen width. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={backdrop}
            alt=""
            className="h-full w-full object-cover object-top animate-fade-in"
            style={{
              maskImage:
                "linear-gradient(to bottom, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.82) 18%, rgba(0,0,0,0.50) 35%, rgba(0,0,0,0.18) 52%, rgba(0,0,0,0.04) 65%, rgba(0,0,0,0) 72%)",
              WebkitMaskImage:
                "linear-gradient(to bottom, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.82) 18%, rgba(0,0,0,0.50) 35%, rgba(0,0,0,0.18) 52%, rgba(0,0,0,0.04) 65%, rgba(0,0,0,0) 72%)",
            }}
          />
          {/* Left vignette for text contrast */}
          <div className="absolute inset-0 bg-linear-to-r from-slate-950/60 via-slate-950/10 to-transparent" />
        </div>
      )}

      {/* ── Navigation zone — defines the visual hero height ── */}
      <div className="relative h-[32vw] min-h-[180px] max-h-[380px] xl:max-h-[520px]">
        <button
          onClick={() => router.back()}
          className="absolute left-4 top-4 sm:left-6 md:left-8 flex items-center gap-1.5 rounded-lg bg-black/40 px-3 py-1.5 text-xs text-white backdrop-blur-xs hover:bg-black/60"
        >
          <ArrowLeft size={14} /> {t('common.back')}
        </button>
        {jfItem && (
          <a
            href={`/api/jellyfin/redirect?itemId=${jfItem.Id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute right-4 top-4 sm:right-6 md:right-8 flex items-center gap-1.5 rounded-lg bg-black/40 px-3 py-1.5 text-xs text-white backdrop-blur-xs hover:bg-black/60"
          >
            <ExternalLink size={14} /> {t('radarr.viewOnJellyfin')}
          </a>
        )}
      </div>

      {/* ── Poster + Metadata — overlaps bottom of nav zone ── */}
      <div className="relative -mt-16 px-4 pb-6 sm:-mt-20 sm:px-6 md:px-8 xl:px-12 2xl:px-16">
        <div className="flex max-w-4xl xl:max-w-6xl 2xl:max-w-7xl items-end gap-4 sm:gap-6">
          <div className="hidden shrink-0 sm:block">
            <div className="h-[132px] w-[88px] overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10 md:h-[168px] md:w-28">
              {poster(movie) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={poster(movie)!} alt={movie.title} className="h-full w-full object-cover" />
              ) : null}
            </div>
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="mb-1 text-xl font-bold leading-tight text-white drop-shadow-sm sm:text-2xl md:text-3xl">
              {movie.title}
              <span className="ml-2 text-base font-normal text-white/60 md:text-lg">({movie.year})</span>
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              {info?.imdbRating && (
                <span className="flex items-center gap-1 rounded-sm bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-400">
                  <Star size={11} className="fill-current" /> {info.imdbRating}
                </span>
              )}
              {info?.tmdb?.runtime && (
                <span className="text-xs text-white/60">{info.tmdb.runtime} min</span>
              )}
              {info?.tmdb?.genres.slice(0, 3).map((g) => (
                <span key={g} className="badge bg-white/10 text-white/70 backdrop-blur-xs">{g}</span>
              ))}
              {jfItem && (
                <span className={`badge ${isWatched ? "bg-emerald-500/25 text-emerald-300" : "bg-white/10 text-white/60"}`}>
                  {isWatched ? t('common.watched') : t('common.notWatched')}
                  {jfItem.UserData?.PlayCount && jfItem.UserData.PlayCount > 1
                    ? ` (${jfItem.UserData.PlayCount}×)`
                    : ""}
                </span>
              )}
              {jsData && <JellyseerrBadge status={jsData.status} isNotReleased={isNotReleased} />}
            </div>
          </div>
        </div>
      </div>

      {/* ── Content below — backdrop fully faded behind the file card ── */}
      <div className="relative px-4 sm:px-6 md:px-8 xl:px-12 2xl:px-16">
      <div className="max-w-4xl xl:max-w-6xl 2xl:max-w-7xl">

      {/* ── Action buttons ─────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {!isGuest && jfItem && (
          <button
            className={`btn-ghost px-3 ${isWatched ? "text-emerald-400" : "text-slate-400"}`}
            onClick={toggleWatched}
            disabled={togglingWatched}
          >
            {isWatched ? <Eye size={16} /> : <EyeOff size={16} />}
            {isWatched ? t('common.watched') : t('radarr.markAsWatched')}
          </button>
        )}
        {movie.tmdbId > 0 && (
          <WatchlistButton
            mediaType="movie"
            tmdbId={movie.tmdbId}
            title={movie.title}
            year={movie.year}
            posterPath={posterUrl(movie.images, "thumb")}
          />
        )}
        {/* Unified request button — visible only when not yet downloaded or in progress */}
        {canRequest && (
          <button
            className="btn-secondary px-3"
            onClick={requestMovie}
            disabled={requesting}
          >
            <Send size={14} />
            {requesting ? t('common.requesting') : t('common.request')}
          </button>
        )}
        {info?.trailerKey && (
          <button className="btn-ghost px-3" onClick={() => setShowTrailer(true)}>
            <PlayCircle size={16} /> {t('common.trailer')}
          </button>
        )}
        {!isGuest && (
          <>
            <button className="btn-ghost px-3" onClick={() => setShowNfo(true)}>
              <Info size={16} /> NFO
            </button>
            <button className="btn-primary" onClick={() => setShowSearch(true)}>
              <Search size={16} /> {t('common.interactiveSearch')}
            </button>
          </>
        )}
      </div>

      {/* "En attente de sortie" notice for films still in cinemas */}
      {isNotReleased && jsData && jsData.status > 1 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <Info size={15} className="mt-0.5 shrink-0 text-amber-400" />
          <span>
            {t('radarr.releaseNoticePrefix')}{" "}
            <span className="font-medium">
              {movie.status === "inCinemas" ? t('radarr.inCinemas') : t('radarr.notReleased')}
            </span>
            {t('radarr.releaseNoticeSuffix')}
          </span>
        </div>
      )}

      {/* ── Mobile tab bar ─────────────────────────────────────── */}
      <div className="mb-4 flex rounded-xl border border-white/10 bg-white/5 p-1 md:hidden">
        {(["infos", "casting", "fichier"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); haptic(30); }}
            className={`flex-1 rounded-lg py-1.5 text-xs font-medium capitalize transition-colors ${
              activeTab === tab ? "bg-white/15 text-white" : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {tab === "infos" ? t('radarr.tabInfos') : tab === "casting" ? t('radarr.tabCasting') : t('radarr.tabFile')}
          </button>
        ))}
      </div>

      {/* ── Tagline + Overview ──────────────────────────────────── */}
      <div className={activeTab !== "infos" ? "hidden md:block" : ""}>
      {info?.tmdb?.tagline && (
        <p className="mb-2 text-sm italic text-slate-500">{info.tmdb.tagline}</p>
      )}
      {overview && <p className="mb-4 max-w-2xl text-sm text-slate-400">{overview}</p>}
      <ErrorBoundary><MediaRatings imdbId={movie.imdbId} /></ErrorBoundary>

      {/* ── Settings card ──────────────────────────────────────── */}
      {isGuest ? (
        <div className="card mb-4 flex flex-wrap items-center gap-4 p-4 text-sm text-slate-300">
          <span className="badge bg-white/5">{movie.monitored ? t('common.monitored') : t('common.notMonitored')}</span>
          {meta?.qualityProfiles?.find((p) => p.id === movie.qualityProfileId) && (
            <span className="badge bg-white/5">
              {meta.qualityProfiles.find((p) => p.id === movie.qualityProfileId)?.name}
            </span>
          )}
        </div>
      ) : (
        <div className="card mb-4 flex flex-wrap items-center gap-4 p-4">
          <Toggle
            checked={movie.monitored}
            onChange={(value) => save({ monitored: value })}
            label={t('common.monitored')}
          />
          <label className="flex items-center gap-2 text-sm text-slate-300">
            {t('common.qualityProfile')}
            <select
              className="select"
              value={qualityProfileId ?? ""}
              disabled={saving}
              onChange={(e) => {
                const value = Number(e.target.value);
                setQualityProfileId(value);
                save({ qualityProfileId: value });
              }}
            >
              {meta?.qualityProfiles?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() => setConfirmModal("radarr")}
            disabled={deletingFromRadarr}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
          >
            <Trash2 size={12} /> {t('radarr.deleteFromRadarr')}
          </button>
        </div>
      )}

      {/* ── Active download (always visible) ───────────────────── */}
      {info?.activeDownload && (
        <div className="card mb-4 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm text-white">
            <Download size={16} className="text-accent-400" />
            <span className="truncate">{info.activeDownload.title}</span>
          </div>
          <p className="mb-2 text-xs text-slate-500">
            {info.activeDownload.indexer} · {info.activeDownload.trackedDownloadStatus}
          </p>
          <div className="h-1.5 w-full rounded-full bg-slate-800">
            <div className="h-1.5 rounded-full bg-accent-500" style={{ width: `${downloadProgress}%` }} />
          </div>
        </div>
      )}
      <ErrorBoundary><SimilarMedia apiUrl={`/api/radarr/movies/${movie.id}/similar`} type="movie" /></ErrorBoundary>
      </div>{/* end infos tab */}

      {/* ── File + Subtitles ────────────────────────────────────── */}
      <div className={activeTab !== "fichier" ? "hidden md:block" : ""}>
      <Collapsible title={t('radarr.tabFile')} icon={<HardDrive size={15} className="text-accent-400" />} className="mb-4">
        {movie.hasFile && movie.movieFile ? (
          <div className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-slate-800 p-2 text-accent-400">
                  <HardDrive size={20} />
                </div>
                <div className="text-sm">
                  <p className="text-white">
                    {movie.movieFile.quality?.quality?.name} · {formatBytes(movie.movieFile.size)}
                  </p>
                  <p className="text-slate-500">
                    {movie.movieFile.mediaInfo?.videoCodec}
                    {movie.movieFile.mediaInfo?.resolution ? ` · ${movie.movieFile.mediaInfo.resolution}` : ""}
                    {movie.movieFile.mediaInfo?.audioCodec ? ` · ${movie.movieFile.mediaInfo.audioCodec}` : ""}
                    {movie.movieFile.mediaInfo?.videoDynamicRangeType
                      ? ` · ${movie.movieFile.mediaInfo.videoDynamicRangeType}`
                      : ""}
                  </p>
                </div>
              </div>
              {!isGuest && (
                <button
                  onClick={() => setConfirmModal("file")}
                  disabled={deletingFile}
                  className="btn-danger px-2 py-1.5"
                  title={t('radarr.deleteFileButton')}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {(info?.subtitles?.length || info?.audioLanguages?.length) ? (
              <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-white/5 pt-3">
                {info.audioLanguages.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Mic2 size={14} className="text-accent-400" />
                    {info.audioLanguages.map((l) => (
                      <span key={l.code2} className="badge bg-white/5 text-slate-300">{l.name}</span>
                    ))}
                  </div>
                )}
                {info.subtitles.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Captions size={14} className="text-accent-400" />
                    {info.subtitles.map((s, i) => (
                      <span key={i} className="badge bg-white/5 text-slate-300">
                        {s.name}{s.forced ? ` (${t('radarr.forced')})` : ""}{s.hi ? " HI" : ""}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="card p-4 text-sm text-amber-400">{t('radarr.fileNotDownloaded')}</div>
        )}
      </Collapsible>

      </div>{/* end fichier tab */}

      {/* ── Collection (always visible) ─────────────────────────── */}
      {info?.tmdb?.collection && (
        <div className="mb-4">
          <button
            onClick={() => setShowCollection(true)}
            className="flex items-center gap-2 rounded-lg border border-accent-500/30 bg-accent-600/10 px-4 py-2 text-sm text-accent-400 transition-colors hover:bg-accent-600/20"
          >
            <span className="text-base">🎬</span>
            {t('radarr.saga')} · {info.tmdb.collection.name}
          </button>
        </div>
      )}

      {/* ── Cast ────────────────────────────────────────────────── */}
      <div className={activeTab !== "casting" ? "hidden md:block" : ""}>
      {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
        <Collapsible title={t('radarr.tabCasting')} badge={info.tmdb.cast.length} icon={<Film size={15} className="text-accent-400" />}>
          <HorizontalCarousel className="scrollbar-thin flex gap-3 overflow-x-auto p-3 scroll-px-3 snap-x snap-mandatory">
            {info.tmdb.cast.map((actor) => {
              const isVip = actor.tmdbId === 3247402 && process.env.NEXT_PUBLIC_CLARA_GALLERY_ENABLED !== "false";
              return (
                <button
                  key={actor.tmdbId}
                  className="w-20 shrink-0 snap-start text-center touch-manipulation"
                  onClick={() => isVip ? router.push("/person/3247402") : setSelectedActor({ tmdbId: actor.tmdbId, name: actor.name, photoUrl: actor.photoUrl })}
                >
                  <div className={`mb-1.5 aspect-square overflow-hidden rounded-full bg-slate-800 transition-all ${
                    isVip
                      ? "ring-2 ring-yellow-400 ring-offset-2 ring-offset-slate-900 shadow-[0_0_12px_rgba(250,204,21,0.5)]"
                      : "ring-0 hover:ring-2 hover:ring-accent-500"
                  }`}>
                    {actor.photoUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={actor.photoUrl} alt={actor.name} className="h-full w-full object-cover" />
                    )}
                  </div>
                  <p className={`truncate text-xs ${isVip ? "text-yellow-400 font-medium" : "text-slate-300"}`}>{actor.name}</p>
                  <p className="truncate text-[11px] text-slate-500">{actor.character}</p>
                </button>
              );
            })}
          </HorizontalCarousel>
        </Collapsible>
      )}

      </div>{/* end casting tab */}

      {showCollection && info?.tmdb?.collection && (
        <CollectionModal
          collectionId={info.tmdb.collection.id}
          collectionName={info.tmdb.collection.name}
          onClose={() => setShowCollection(false)}
        />
      )}

      {selectedActor && (
        <ActorModal
          tmdbPersonId={selectedActor.tmdbId}
          name={selectedActor.name}
          photoUrl={selectedActor.photoUrl}
          onClose={() => setSelectedActor(null)}
        />
      )}

      {showSearch && (
        <ReleaseSearchModal
          title={t('radarr.searchModalTitle', { title: movie.title })}
          searchEndpoint={`/api/radarr/movies/${id}/releases`}
          grabEndpoint="/api/radarr/releases"
          onClose={() => setShowSearch(false)}
        />
      )}

      {showTrailer && info?.trailerKey && (
        <TrailerModal youtubeKey={info.trailerKey} title={t('radarr.trailerModalTitle', { title: movie.title })} onClose={() => setShowTrailer(false)} />
      )}
      {showNfo && movie && <MediaInfoModal movie={movie} onClose={() => setShowNfo(false)} />}

      {confirmModal && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs" onClick={() => setConfirmModal(null)}>
          <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-white">
              {confirmModal === "file" ? t('radarr.confirmDeleteFile') : t('radarr.confirmDeleteRadarr')}
            </p>
            <p className="mt-1.5 text-xs text-slate-400">
              {confirmModal === "file"
                ? t('radarr.confirmDeleteFileBody')
                : t('radarr.confirmDeleteRadarrBody', { title: movie?.title ?? "" })}
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setConfirmModal(null)} className="flex-1 rounded-xl border border-white/10 py-2 text-sm text-slate-400 hover:text-white transition-colors">
                {t('common.cancel')}
              </button>
              <button
                onClick={() => { setConfirmModal(null); if (confirmModal === "file") deleteFile(); else deleteFromRadarr(); }}
                className="flex-1 rounded-xl bg-red-500 py-2 text-sm font-semibold text-white hover:bg-red-400 transition-colors"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      </div>{/* end max-w-4xl */}
      </div>{/* end px wrapper */}
    </div>
  );
}

const JS_STATUS_CLS: Record<number, string> = {
  2: "bg-amber-500/20 text-amber-400",
  3: "bg-blue-500/20 text-blue-400",
  4: "bg-sky-500/20 text-sky-400",
  5: "bg-emerald-500/20 text-emerald-400",
};

function JellyseerrBadge({ status, isNotReleased }: { status: number; isNotReleased?: boolean }) {
  const t = useT();
  const JS_STATUS_LABEL: Record<number, string> = {
    2: t('radarr.jsStatusPending'),
    3: t('radarr.jsStatusProcessing'),
    4: t('radarr.jsStatusPartial'),
    5: t('radarr.jsStatusAvailable'),
  };
  if (isNotReleased && (status === 2 || status === 3)) {
    return (
      <span className="badge bg-amber-500/20 text-amber-400 backdrop-blur-xs">
        {t('radarr.awaitingRelease')}
      </span>
    );
  }
  const cls = JS_STATUS_CLS[status];
  const label = JS_STATUS_LABEL[status];
  if (!cls) return null;
  return <span className={`badge backdrop-blur-xs ${cls}`}>{label}</span>;
}

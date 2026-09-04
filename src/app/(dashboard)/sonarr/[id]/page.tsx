"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import useSWRImmutable from "swr/immutable";
import { fetcher } from "@/lib/swr";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { DetailSkeleton } from "@/components/DetailSkeleton";
import { Toggle } from "@/components/Toggle";
import dynamic from "next/dynamic";
const ReleaseSearchModal = dynamic(() => import("@/components/ReleaseSearchModal").then((m) => m.ReleaseSearchModal), { ssr: false });
const TrailerModal = dynamic(() => import("@/components/TrailerModal").then((m) => m.TrailerModal), { ssr: false });
const ActorModal = dynamic(() => import("@/components/ActorModal").then((m) => m.ActorModal), { ssr: false });
import { Collapsible } from "@/components/Collapsible";
import { PlayButton } from "@/components/PlayButton";
import { haptic } from "@/lib/haptic";
import {
  ArrowLeft,
  Tv,
  Search,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Circle,
  Star,
  Download,
  Captions,
  Eye,
  EyeOff,
  ExternalLink,
  Send,
  PlayCircle,
  Trash2,
  RefreshCw,
} from "lucide-react";
import type { SonarrSeries, SonarrEpisode } from "@/lib/clients/sonarr";
import type { BazarrEpisodeDetails } from "@/lib/clients/bazarr";
import type { JellyfinItem } from "@/lib/clients/jellyfin";
import { posterUrl } from "@/lib/images";
import { formatResumeTicks } from "@/lib/format";
import { useRole } from "@/lib/useRole";
import { canAutoSearchSeason, canAutoSearchSeries } from "@/lib/mediaPermissions";
import { MoreMenu } from "@/components/MoreMenu";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import { apiAction } from "@/lib/apiAction";
import { TitleLogo } from "@/components/TitleLogo";
import { WatchlistButton } from "@/components/WatchlistButton";
import { Rail } from "@/components/Rail";
import { MediaRatings } from "@/components/MediaRatings";
import { SimilarMedia } from "@/components/SimilarMedia";
import { ErrorBoundary } from "@/components/ErrorBoundary";

interface SeriesInfo {
  logoUrl: string | null;
  trailerKey: string | null;
  tmdb: {
    overview: string;
    tagline?: string;
    genres: string[];
    runtime: number | null;
    backdropUrl: string | null;
    cast: { tmdbId: number; name: string; character: string; photoUrl: string | null }[];
  } | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  episodeSubtitles: BazarrEpisodeDetails[];
  activeDownloads: {
    episodeId: number;
    title: string;
    status: string;
    trackedDownloadStatus: string;
    size: number;
    sizeleft: number;
    indexer: string;
  }[];
}

function poster(series: SonarrSeries) {
  return posterUrl(series.images, "full");
}

interface ActiveSearch {
  title: string;
  endpoint: string;
}

export default function SonarrSeriesDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { isGuest, jfId } = useRole();
  const toast = useToast();
  const t = useT();
  const [selectedActor, setSelectedActor] = useState<{ tmdbId: number; name: string; photoUrl: string | null } | null>(null);
  const seriesKey = `/api/sonarr/series/${id}`;
  const episodesKey = `/api/sonarr/series/${id}/episodes`;

  const { data: series, error, isLoading } = useSWR<SonarrSeries>(seriesKey, fetcher);
  const { data: episodes, error: episodesError } = useSWR<SonarrEpisode[]>(episodesKey, fetcher);
  const { data: meta } = useSWRImmutable<{ qualityProfiles: { id: number; name: string }[] }>("/api/sonarr/meta", fetcher);
  const { data: info } = useSWR<SeriesInfo>(`/api/sonarr/series/${id}/info`, fetcher);
  const { data: jfData, mutate: mutateJf } = useSWR<{ item: JellyfinItem | null }>(
    series
      ? `/api/jellyfin/items?tvdbId=${series.tvdbId ?? 0}&type=Series&title=${encodeURIComponent(series.title)}&year=${series.year ?? ""}`
      : null,
    fetcher
  );

  const { data: jsData, mutate: mutateJs } = useSWR<{ status: number }>(
    series?.tmdbId ? `/api/jellyseerr/media?tmdbId=${series.tmdbId}&type=tv` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const { data: jfEpisodesData } = useSWR<{ episodes: JellyfinItem[]; nextUp: JellyfinItem | null }>(
    jfData?.item ? `/api/jellyfin/series/${jfData.item.Id}/episodes` : null,
    fetcher
  );

  const [qualityProfileId, setQualityProfileId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [openSeasons, setOpenSeasons] = useState<Set<number>>(new Set());
  const [activeSearch, setActiveSearch] = useState<ActiveSearch | null>(null);
  const [autoSearching, setAutoSearching] = useState<number | null>(null);
  const [seriesSearching, setSeriesSearching] = useState(false);
  const [togglingWatched, setTogglingWatched] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingFromSonarr, setDeletingFromSonarr] = useState(false);
  const [activeTab, setActiveTab] = useState<"infos" | "casting" | "saisons">("infos");

  // Adjusts state from the fetched `series` data during render (not in an effect) per React's
  // guidance for this pattern, to avoid an extra render pass.
  const [profileSyncedFor, setProfileSyncedFor] = useState(series);
  if (series !== profileSyncedFor) {
    setProfileSyncedFor(series);
    if (series) setQualityProfileId(series.qualityProfileId);
  }

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (e.key === "f") {
        (document.querySelector('button[title="Ajouter à la liste"],button[title="Retirer de la liste"]') as HTMLButtonElement)?.click();
      }
      if (e.key === "1") setActiveTab("infos");
      if (e.key === "2") setActiveTab("casting");
      if (e.key === "3") setActiveTab("saisons");
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const episodesBySeason = useMemo(() => {
    const map = new Map<number, SonarrEpisode[]>();
    for (const ep of episodes ?? []) {
      const list = map.get(ep.seasonNumber) ?? [];
      list.push(ep);
      map.set(ep.seasonNumber, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.episodeNumber - b.episodeNumber);
    return map;
  }, [episodes]);

  const jfEpisodeByKey = useMemo(() => {
    const map = new Map<string, JellyfinItem>();
    for (const e of jfEpisodesData?.episodes ?? []) {
      if (e.ParentIndexNumber != null && e.IndexNumber != null) {
        map.set(`${e.ParentIndexNumber}-${e.IndexNumber}`, e);
      }
    }
    return map;
  }, [jfEpisodesData]);

  const jfEpisodeById = useMemo(() => {
    const map = new Map<string, JellyfinItem>();
    for (const e of jfEpisodesData?.episodes ?? []) map.set(e.Id, e);
    return map;
  }, [jfEpisodesData]);

  // Powers the credits-time "next up" prompt: same season, next episode
  // number. Doesn't roll over into the next season — a reasonable first cut,
  // the prompt just won't appear on a season finale.
  const getNextEpisode = useCallback(
    (currentItemId: string): { itemId: string; title: string } | null => {
      const current = jfEpisodeById.get(currentItemId);
      if (!current || current.IndexNumber == null || current.ParentIndexNumber == null || !series) return null;
      const next = jfEpisodeByKey.get(`${current.ParentIndexNumber}-${current.IndexNumber + 1}`);
      if (!next) return null;
      return { itemId: next.Id, title: `${series.title} · EP${next.IndexNumber} S${next.ParentIndexNumber}` };
    },
    [jfEpisodeById, jfEpisodeByKey, series]
  );

  // Netflix-style series play button: resume the in-progress/next-unwatched
  // episode Jellyfin already tracks (its own "Next Up" logic), or fall back
  // to S1E1 when nothing has ever been played.
  const seriesPlayTarget = useMemo(() => {
    if (!series) return null;
    const pick = (ep: JellyfinItem) => {
      const resumeTicks = ep.UserData?.PlaybackPositionTicks;
      const epLabel = `EP${ep.IndexNumber} S${ep.ParentIndexNumber}`;
      const label =
        resumeTicks && resumeTicks > 0
          ? `${t('common.resume')} ${epLabel} - ${formatResumeTicks(resumeTicks)}`
          : `${t('common.play')} ${epLabel}`;
      return { itemId: ep.Id, title: `${series.title} · ${epLabel}`, resumeTicks, runtimeTicks: ep.RunTimeTicks, label };
    };
    if (jfEpisodesData?.nextUp) return pick(jfEpisodesData.nextUp);
    const first =
      jfEpisodeByKey.get("1-1") ??
      [...jfEpisodeByKey.values()].sort(
        (a, b) => (a.ParentIndexNumber! - b.ParentIndexNumber!) || (a.IndexNumber! - b.IndexNumber!)
      )[0];
    return first ? pick(first) : null;
  }, [series, jfEpisodesData, jfEpisodeByKey, t]);

  const subtitlesByEpisode = useMemo(() => {
    const map = new Map<number, BazarrEpisodeDetails>();
    for (const e of info?.episodeSubtitles ?? []) map.set(e.sonarrEpisodeId, e);
    return map;
  }, [info]);

  const downloadByEpisode = useMemo(() => {
    const map = new Map<number, SeriesInfo["activeDownloads"][number]>();
    for (const d of info?.activeDownloads ?? []) map.set(d.episodeId, d);
    return map;
  }, [info]);

  async function saveSeries(payload: Partial<SonarrSeries>) {
    if (!series) return;
    setSaving(true);
    try {
      // `fetch` ne lève pas sur un 404 ou un 502 : le `catch` juste en dessous existait depuis
      // toujours et n'avait jamais rien attrapé. Cet écran annonçait donc « enregistré » quel
      // que soit ce que le serveur avait répondu.
      await apiAction(seriesKey, { method: "PUT", body: JSON.stringify({ ...series, ...payload }) });
      mutate(seriesKey);
      toast.success(t('sonarr.saveSuccess'));
    } catch {
      toast.error(t('sonarr.saveError'));
    } finally {
      setSaving(false);
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
      toast.success(newPlayed ? t('sonarr.watchedSuccess') : t('sonarr.unwatchedSuccess'));
    } catch {
      mutateJf(); // rollback
      toast.error(t('sonarr.watchedError'));
    } finally {
      setTogglingWatched(false);
    }
  }

  // Standard automatic search (Sonarr's own SeasonSearch command) — available to every user,
  // unlike the interactive one below (a human picking a specific release), which stays
  // admin/non-guest-only same as before.
  async function triggerAutoSearch(seasonNumber: number) {
    setAutoSearching(seasonNumber);
    try {
      await apiAction(`/api/sonarr/series/${id}/search?seasonNumber=${seasonNumber}`, { method: "POST" });
      toast.success(t('sonarr.searchLaunched'));
    } catch (error) {
      // Sonarr explique pourquoi il refuse une recherche ; autant le répéter plutôt que « erreur ».
      toast.error(error instanceof Error ? error.message : t('common.unknown'));
    } finally {
      setAutoSearching(null);
    }
  }

  // La recherche automatique de la série entière — l'équivalent de celle de la fiche film, qui
  // n'existait ici qu'au niveau d'une saison.
  async function triggerSeriesAutoSearch() {
    setSeriesSearching(true);
    try {
      await apiAction(`/api/sonarr/series/${id}/search`, { method: "POST" });
      toast.success(t('sonarr.searchLaunched'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.unknown'));
    } finally {
      setSeriesSearching(false);
    }
  }

  async function toggleSeasonMonitored(seasonNumber: number, value: boolean) {
    if (!series?.seasons) return;
    const seasons = series.seasons.map((s) =>
      s.seasonNumber === seasonNumber ? { ...s, monitored: value } : s
    );
    await saveSeries({ seasons });
  }

  /**
   * Le bouton répond tout de suite, le serveur tranche ensuite.
   *
   * Il ne répondait qu'après l'aller-retour, et seulement si celui-ci réussissait : un serveur
   * lent laissait la pastille inerte sous le doigt, et un serveur qui refusait la laissait
   * inerte pour toujours, sans un mot. L'état est donc écrit sur place, puis confirmé — et
   * remis comme il était si le serveur dit non.
   */
  async function toggleEpisodeMonitored(episode: SonarrEpisode, value: boolean) {
    const optimistic = (list?: SonarrEpisode[]) =>
      list?.map((e) => (e.id === episode.id ? { ...e, monitored: value } : e));
    mutate(episodesKey, optimistic, { revalidate: false });
    try {
      await apiAction(`/api/sonarr/episodes/${episode.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...episode, monitored: value }),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sonarr.saveError'));
    } finally {
      mutate(episodesKey);
    }
  }

  function toggleSeasonOpen(seasonNumber: number) {
    setOpenSeasons((prev) => {
      const next = new Set(prev);
      next.has(seasonNumber) ? next.delete(seasonNumber) : next.add(seasonNumber);
      return next;
    });
  }

  async function requestSeries() {
    if (!series?.tmdbId) return;
    setRequesting(true);
    try {
      const jsRes = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: "tv", mediaId: series.tmdbId }),
      });
      if (!jsRes.ok) {
        const searchRes = await fetch(`/api/sonarr/series/${id}/search`, { method: "POST" });
        if (!searchRes.ok) throw new Error();
      }
      mutateJs();
      await fetch("/api/cache/invalidate", { method: "POST" });
      haptic();
      toast.success(t('sonarr.requestSuccess', { title: series.title }));
    } catch {
      toast.error(t('sonarr.requestError'));
    } finally {
      setRequesting(false);
    }
  }

  async function deleteFromSonarr() {
    setDeletingFromSonarr(true);
    try {
      const res = await fetch(`/api/sonarr/series/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      await fetch("/api/cache/invalidate", { method: "POST" });
      toast.success(t('sonarr.deleteSuccess', { title: series?.title ?? "" }));
      router.back();
    } catch {
      toast.error(t('sonarr.deleteError'));
      setDeletingFromSonarr(false);
    }
  }

  if (isLoading) return <DetailSkeleton />;
  if (error || !series) return <ErrorState message={error?.message || t('sonarr.seriesNotFound')} />;

  const seasonNumbers = [...episodesBySeason.keys()].sort((a, b) => a - b);
  const overview = info?.tmdb?.overview || series.overview;
  const backdrop = info?.tmdb?.backdropUrl;
  const jfItem = jfData?.item;
  const isWatched = jfItem?.UserData?.Played ?? false;
  const fileCount = series.statistics?.episodeFileCount ?? 0;
  const episodeCount = series.statistics?.episodeCount ?? 0;
  // Une série déjà complète n'est pas à demander. Le bouton restait proposé quel que soit ce
  // qu'il y avait sur le disque, alors que la fiche film s'en préoccupait depuis toujours.
  const isComplete = episodeCount > 0 && fileCount >= episodeCount;
  const canRequest = !isComplete && (!jsData || jsData.status === 1);

  return (
    <div className="relative -mx-4 -mt-4 sm:-mx-6 sm:-mt-6 md:-mx-8 md:-mt-6">

      {/* ── Backdrop — natural 16:9 ratio, absolute so it never clips ── */}
      {backdrop && (
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video">
          {/* The image fades out via its own alpha mask (not a solid-color overlay) so
              what shows through underneath is the page's real background — including its
              radial accent glows — instead of an approximated flat color that never quite
              matches and leaves a visible seam. */}
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
          <div className="absolute inset-0 bg-linear-to-r from-ink/60 via-ink/10 to-transparent" />
        </div>
      )}

      {/* ── Navigation zone ── */}
      <div className="relative h-[32vw] min-h-[180px] max-h-[380px] xl:max-h-[520px]">
        <button
          onClick={() => router.back()}
          className="btn-overlay absolute left-4 top-4 gap-1.5 px-3 py-1.5 text-xs sm:left-6 md:left-8"
        >
          <ArrowLeft size={14} /> {t('common.back')}
        </button>
        {jfItem && (
          <a
            href={`/api/jellyfin/redirect?itemId=${jfItem.Id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-overlay absolute right-4 top-4 gap-1.5 px-3 py-1.5 text-xs sm:right-6 md:right-8"
          >
            <ExternalLink size={14} /> {t('sonarr.viewOnJellyfin')}
          </a>
        )}
      </div>

      {/* ── Poster + Metadata ── */}
      <div className="relative -mt-16 px-4 pb-6 sm:-mt-20 sm:px-6 md:px-8 xl:px-12 2xl:px-16">
        <div className="flex max-w-4xl xl:max-w-6xl 2xl:max-w-7xl items-end gap-4 sm:gap-6">
          <div className="hidden shrink-0 sm:block">
            <div className="h-[132px] w-[88px] overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10 md:h-[168px] md:w-28">
              {poster(series) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={poster(series)!} alt={series.title} className="h-full w-full object-cover" />
              ) : null}
            </div>
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <TitleLogo
              logoUrl={info?.logoUrl}
              title={series.title}
              year={series.year}
              className="mb-1 text-xl sm:text-2xl md:text-3xl"
              logoClassName="max-h-14 sm:max-h-16 md:max-h-20"
            />
            <div className="flex flex-wrap items-center gap-2">
              {info?.imdbRating && (
                <span className="flex items-center gap-1 rounded-sm bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-400">
                  <Star size={11} className="fill-current" /> {info.imdbRating}
                </span>
              )}
              {info?.tmdb?.runtime && (
                <span className="text-xs text-white/60">{t('sonarr.minPerEp', { n: info.tmdb.runtime })}</span>
              )}
              {info?.tmdb?.genres.slice(0, 3).map((g) => (
                <span key={g} className="badge bg-white/10 text-white/70 backdrop-blur-xs">{g}</span>
              ))}
              {jfItem && (
                <span className={`badge ${isWatched ? "bg-emerald-500/25 text-emerald-300" : "bg-white/10 text-white/60"}`}>
                  {isWatched ? t('sonarr.seriesWatched') : t('sonarr.seriesNotWatched')}
                </span>
              )}
              {jsData && <JellyseerrBadge status={jsData.status} />}
            </div>
          </div>
        </div>
      </div>

      {/* ── Content below — backdrop fully faded behind the file card ── */}
      <div className="relative px-4 sm:px-6 md:px-8 xl:px-12 2xl:px-16">
      <div className="max-w-4xl xl:max-w-6xl 2xl:max-w-7xl">

      {/* ── Action buttons ─────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {seriesPlayTarget && (
          <PlayButton
            itemId={seriesPlayTarget.itemId}
            title={seriesPlayTarget.title}
            resumeTicks={seriesPlayTarget.resumeTicks}
            runtimeTicks={seriesPlayTarget.runtimeTicks}
            label={seriesPlayTarget.label}
            variant="primary"
            getNextEpisode={getNextEpisode}
          />
        )}
        {/* L'épisode en cours, repris depuis son début. Ne s'affiche que si un épisode est bien
            entamé : sur une série qu'on n'a pas commencée, il n'y a rien à recommencer. */}
        {seriesPlayTarget && (
          <PlayButton
            restart
            itemId={seriesPlayTarget.itemId}
            title={seriesPlayTarget.title}
            resumeTicks={seriesPlayTarget.resumeTicks}
            label={t('sonarr.restartEpisode')}
            className="btn btn-ghost"
            iconSize={16}
            getNextEpisode={getNextEpisode}
          />
        )}
        {!isGuest && jfItem && (
          <button
            className={`btn-ghost px-3 ${isWatched ? "text-emerald-400" : "text-slate-400"}`}
            onClick={toggleWatched}
            disabled={togglingWatched}
          >
            {isWatched ? <Eye size={16} /> : <EyeOff size={16} />}
            {isWatched ? t('sonarr.seriesWatched') : t('sonarr.markWatched')}
          </button>
        )}
        {series.tmdbId && (
          <WatchlistButton
            mediaType="series"
            tmdbId={series.tmdbId}
            title={series.title}
            year={series.year}
            posterPath={posterUrl(series.images, "thumb")}
          />
        )}
        {canRequest && (
          <button
            className="btn-ghost px-3"
            onClick={requestSeries}
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
        {/* Comme sur la fiche film : tout ce qui est technique passe derrière un seul bouton
            plutôt qu'à côté des autres. La recherche interactive était ici un *second* primaire,
            dans la même couleur que Lecture — deux actions principales, donc aucune. */}
        <MoreMenu
          label={t('common.moreOptions')}
          items={[
            ...(canAutoSearchSeries(isGuest, fileCount, episodeCount)
              ? [{
                  label: t('sonarr.autoSearchSeries'),
                  icon: <RefreshCw size={16} className={seriesSearching ? "animate-spin" : ""} />,
                  onSelect: triggerSeriesAutoSearch,
                  disabled: seriesSearching,
                }]
              : []),
            ...(!isGuest
              ? [{
                  label: t('common.interactiveSearch'),
                  icon: <Search size={16} />,
                  onSelect: () => setActiveSearch({ title: t('sonarr.seriesSearch', { title: series.title }), endpoint: `/api/sonarr/series/${id}/releases` }),
                }]
              : []),
          ]}
        />
      </div>

      {/* ── Mobile tab bar ─────────────────────────────────────── */}
      <div className="mb-4 flex rounded-xl border border-white/10 bg-white/5 p-1 md:hidden">
        {(["infos", "casting", "saisons"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); haptic(30); }}
            className={`btn btn-sm flex-1 justify-center capitalize ${activeTab === tab ? "btn-on" : "text-slate-500"}`}
            aria-pressed={activeTab === tab}
          >
            {tab === "infos" ? t('sonarr.tabInfos') : tab === "casting" ? t('sonarr.tabCasting') : t('sonarr.tabSeasons')}
          </button>
        ))}
      </div>

      {/* ── Tagline + Overview ──────────────────────────────────── */}
      <div className={activeTab !== "infos" ? "hidden md:block" : ""}>
      {info?.tmdb?.tagline && (
        <p className="mb-2 text-sm italic text-slate-500">{info.tmdb.tagline}</p>
      )}
      {overview && <p className="mb-4 max-w-2xl text-sm text-slate-400">{overview}</p>}
      <ErrorBoundary><MediaRatings imdbId={series.imdbId} /></ErrorBoundary>

      {/* ── Settings card ──────────────────────────────────────── */}
      {isGuest ? (
        <div className="card mb-6 flex flex-wrap items-center gap-4 p-4 text-sm text-slate-300">
          <span className="badge bg-white/5">{series.monitored ? t('common.monitored') : t('common.notMonitored')}</span>
          {meta?.qualityProfiles?.find((p) => p.id === series.qualityProfileId) && (
            <span className="badge bg-white/5">
              {meta.qualityProfiles.find((p) => p.id === series.qualityProfileId)?.name}
            </span>
          )}
        </div>
      ) : (
        <div className="card mb-6 flex flex-wrap items-center gap-4 p-4">
          <Toggle
            checked={series.monitored}
            onChange={(value) => saveSeries({ monitored: value })}
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
                saveSeries({ qualityProfileId: value });
              }}
            >
              {meta?.qualityProfiles?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={deletingFromSonarr}
            className="btn btn-ghost btn-sm ml-auto text-red-400/80"
          >
            <Trash2 size={12} /> {t('sonarr.deleteFromSonarr')}
          </button>
        </div>
      )}

      <ErrorBoundary><SimilarMedia apiUrl={`/api/sonarr/series/${series.id}/similar`} type="series" /></ErrorBoundary>
      </div>{/* end infos tab */}

      {/* ── Cast ────────────────────────────────────────────────── */}
      <div className={activeTab !== "casting" ? "hidden md:block" : ""}>
      {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
        <Collapsible title={t('sonarr.tabCasting')} badge={info.tmdb.cast.length} icon={<Tv size={15} className="text-accent-400" />} className="mb-6">
          <Rail>
            {info.tmdb.cast.map((actor) => {
              const isVip = actor.tmdbId === 3247402 && process.env.NEXT_PUBLIC_CLARA_GALLERY_ENABLED !== "false";
              return (
                <button
                  key={actor.tmdbId}
                  className="w-20 shrink-0 snap-start text-center touch-manipulation"
                  onClick={() => isVip ? router.push("/person/3247402") : setSelectedActor({ tmdbId: actor.tmdbId, name: actor.name, photoUrl: actor.photoUrl })}
                >
                  <div className={`mb-1.5 aspect-square overflow-hidden rounded-full bg-slate-800 transition-shadow ${
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
          </Rail>
        </Collapsible>
      )}

      {selectedActor && (
        <ActorModal
          tmdbPersonId={selectedActor.tmdbId}
          name={selectedActor.name}
          photoUrl={selectedActor.photoUrl}
          onClose={() => setSelectedActor(null)}
        />
      )}
      </div>{/* end casting tab */}

      {/* ── Saisons ─────────────────────────────────────────────── */}
      <div className={activeTab !== "saisons" ? "hidden md:block" : ""}>
      <h2 className="mb-3 text-sm font-semibold text-white">{t('sonarr.seasons')}</h2>
      {episodesError && <ErrorState message={t('sonarr.episodesLoadError')} />}

      <div className="space-y-2">
            {seasonNumbers.map((seasonNumber) => {
              const seasonEpisodes = episodesBySeason.get(seasonNumber) ?? [];
              const seasonMeta = series.seasons?.find((s) => s.seasonNumber === seasonNumber);
              const fileCount = seasonEpisodes.filter((e) => e.hasFile).length;
              const open = openSeasons.has(seasonNumber);

              return (
                <div key={seasonNumber} className="card overflow-hidden">
                  <div
                    className="flex cursor-pointer flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between md:gap-3"
                    onClick={() => toggleSeasonOpen(seasonNumber)}
                  >
                    <div className="flex items-center gap-2 text-sm text-white">
                      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      {seasonNumber === 0 ? t('sonarr.seasonSpecial') : t('sonarr.seasonLabel', { n: String(seasonNumber) })}
                      <span className="text-xs text-slate-500">
                        {t('sonarr.episodesCount', { file: String(fileCount), total: String(seasonEpisodes.length) })}
                      </span>
                    </div>
                    {/* Its own full-width row on mobile (buttons can wrap instead of overflowing
                        the screen edge); back to a single inline row with the title past md. */}
                    <div className="flex flex-wrap items-center gap-2 md:flex-nowrap md:gap-3" onClick={(e) => e.stopPropagation()}>
                      {/* Guests only get the auto-search entry point when the season is missing
                          at least one episode file — a complete season is a fact, not something
                          to search for. Admins always keep it, regardless of completion. */}
                      {canAutoSearchSeason(isGuest, fileCount, seasonEpisodes.length) && (
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={() => triggerAutoSearch(seasonNumber)}
                          disabled={autoSearching === seasonNumber}
                          title={t('sonarr.autoSearchSeason', { n: String(seasonNumber) })}
                          aria-label={t('common.autoSearch')}
                        >
                          <RefreshCw size={14} className={autoSearching === seasonNumber ? "animate-spin" : ""} />
                        </button>
                      )}
                      {isGuest ? (
                        <span className="badge bg-white/5 text-xs">
                          {seasonMeta?.monitored ? t('common.monitored') : t('common.notMonitored')}
                        </span>
                      ) : (
                        <>
                          <button
                            className="btn btn-ghost btn-icon"
                            title={t('sonarr.searchSeason', { n: String(seasonNumber) })}
                            aria-label={t('common.search')}
                            onClick={() =>
                              setActiveSearch({
                                title: t('sonarr.searchSeason', { n: String(seasonNumber) }),
                                endpoint: `/api/sonarr/series/${id}/releases?seasonNumber=${seasonNumber}`,
                              })
                            }
                          >
                            <Search size={14} />
                          </button>
                          <Toggle
                            checked={seasonMeta?.monitored ?? false}
                            onChange={(value) => toggleSeasonMonitored(seasonNumber, value)}
                          />
                        </>
                      )}
                    </div>
                  </div>

                  {open && (
                    <div className="divide-y divide-white/5 border-t border-white/5">
                      {seasonEpisodes.map((ep) => {
                        const subs = subtitlesByEpisode.get(ep.id);
                        const download = downloadByEpisode.get(ep.id);
                        const jfEp = jfEpisodeByKey.get(`${seasonNumber}-${ep.episodeNumber}`);
                        return (
                          <div key={ep.id} className="flex flex-col gap-1.5 p-3 text-sm">
                            {/* Info + actions sit stacked on mobile (title/date row, then a full
                                action row below) but join into a single row past md — title
                                truncates and shrinks to make room instead of leaving dead space
                                to the right of the (now width-capped) play button. */}
                            <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-4">
                              <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-2">
                                  {isGuest ? (
                                    ep.monitored ? (
                                      <CircleCheck size={16} className="text-accent-400" />
                                    ) : (
                                      <Circle size={16} className="text-slate-600" />
                                    )
                                  ) : (
                                    <button onClick={() => toggleEpisodeMonitored(ep, !ep.monitored)}>
                                      {ep.monitored ? (
                                        <CircleCheck size={16} className="text-accent-400" />
                                      ) : (
                                        <Circle size={16} className="text-slate-600" />
                                      )}
                                    </button>
                                  )}
                                  <span className="shrink-0 text-slate-500">{ep.episodeNumber}.</span>
                                  <span className="truncate text-slate-200">{ep.title}</span>
                                </div>
                                {/* Langues, date et état réunis en une seule mention discrète.
                                    Chacun était un objet séparé — deux puces bordées, une date,
                                    un point — soit neuf choses par ligne et dix lignes par
                                    saison. Ce sont des informations qu'on lit *après* le titre,
                                    et elles doivent en avoir l'air. */}
                                <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                                  {subs?.subtitles?.length ? (
                                    <span className="hidden sm:inline">
                                      {subs.subtitles.map((x) => x.name).join(" · ")}
                                    </span>
                                  ) : null}
                                  {ep.airDate && <span className="tabular-nums">{ep.airDate}</span>}
                                  <span
                                    title={ep.hasFile ? t('common.available') : t('common.missing')}
                                    className={`h-1.5 w-1.5 rounded-full ${ep.hasFile ? "bg-emerald-400" : "bg-amber-400"}`}
                                  />
                                </div>
                              </div>
                              {(jfEp || !isGuest) && (
                                <div className="flex shrink-0 items-center gap-2">
                                  {jfEp && (
                                    <PlayButton
                                      itemId={jfEp.Id}
                                      title={`${series.title} · EP${ep.episodeNumber} S${seasonNumber}`}
                                      resumeTicks={jfEp.UserData?.PlaybackPositionTicks}
                                      runtimeTicks={jfEp.RunTimeTicks}
                                      variant="icon"
                                      iconSize={16}
                                      /* Une icône, pas une pastille pleine. Dix boutons
                                         primaires sur un écran, c'est zéro bouton primaire :
                                         l'œil ne sait plus où aller. Elle reste visible en
                                         permanence — la cacher au survol la rendrait
                                         introuvable au doigt. */
                                      className="btn btn-ghost btn-icon text-accent-300"
                                      getNextEpisode={getNextEpisode}
                                    />
                                  )}
                                  {!isGuest && (
                                  <button
                                    className="btn btn-ghost btn-icon shrink-0"
                                    title={t('sonarr.episodeSearch', { title: ep.title })}
                                    onClick={() =>
                                      setActiveSearch({
                                        title: t('sonarr.episodeSearch', { title: ep.title }),
                                        endpoint: `/api/sonarr/series/${id}/releases?episodeId=${ep.id}`,
                                      })
                                    }
                                  >
                                    <Search size={14} />
                                  </button>
                                  )}
                                </div>
                              )}
                            </div>
                            {/* Ne reste sur une seconde ligne que ce qui change tout seul : un
                                téléchargement en cours. Les langues, elles, sont montées dans la
                                mention de droite — elles ne bougent pas, elles n'ont pas besoin
                                d'une ligne à elles. Sur un écran étroit, où elles n'entrent pas,
                                elles reviennent ici. */}
                            {(download || subs?.subtitles?.length) && (
                              <div className="ml-6 flex flex-wrap items-center gap-2 text-[11px]">
                                {subs?.subtitles?.length ? (
                                  <span className="text-slate-500 sm:hidden">
                                    <Captions size={10} className="mr-1 inline" />
                                    {subs.subtitles.map((x) => x.name).join(" · ")}
                                  </span>
                                ) : null}
                                {download && (
                                  <span className="badge bg-accent-600/15 text-[11px] text-accent-400">
                                    <Download size={10} /> {download.trackedDownloadStatus}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
      </div>

      </div>{/* end saisons tab */}

      {showTrailer && info?.trailerKey && (
        <TrailerModal youtubeKey={info.trailerKey} title={t('sonarr.trailerModalTitle', { title: series.title })} onClose={() => setShowTrailer(false)} />
      )}
      {activeSearch && (
        <ReleaseSearchModal
          title={activeSearch.title}
          searchEndpoint={activeSearch.endpoint}
          grabEndpoint="/api/sonarr/releases"
          onClose={() => setActiveSearch(null)}
        />
      )}

      {showDeleteConfirm && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs" onClick={() => setShowDeleteConfirm(false)}>
          <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-white">{t('sonarr.confirmDeleteSonarr')}</p>
            <p className="mt-1.5 text-xs text-slate-400">
              {t('sonarr.confirmDeleteBody', { title: series.title })}
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 rounded-xl border border-white/10 py-2 text-sm text-slate-400 hover:text-white transition-colors">
                {t('common.cancel')}
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); deleteFromSonarr(); }}
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

function JellyseerrBadge({ status }: { status: number }) {
  const t = useT();
  const JS_STATUS_LABEL: Record<number, string> = {
    2: t('sonarr.jsStatusPending'),
    3: t('sonarr.jsStatusProcessing'),
    4: t('sonarr.jsStatusPartial'),
    5: t('sonarr.jsStatusAvailable'),
  };
  const cls = JS_STATUS_CLS[status];
  const label = JS_STATUS_LABEL[status];
  if (!cls) return null;
  return <span className={`badge backdrop-blur-xs ${cls}`}>{label}</span>;
}

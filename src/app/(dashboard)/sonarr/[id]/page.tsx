"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/swr";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { Toggle } from "@/components/Toggle";
import { ReleaseSearchModal } from "@/components/ReleaseSearchModal";
import { TrailerModal } from "@/components/TrailerModal";
import { ActorModal } from "@/components/ActorModal";
import { Collapsible } from "@/components/Collapsible";
import { haptic } from "@/lib/haptic";
import {
  ArrowLeft,
  Tv,
  Search,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Star,
  Download,
  Captions,
  Eye,
  EyeOff,
  ExternalLink,
  Send,
  PlayCircle,
} from "lucide-react";
import type { SonarrSeries, SonarrEpisode } from "@/lib/clients/sonarr";
import type { BazarrEpisodeDetails } from "@/lib/clients/bazarr";
import type { JellyfinItem } from "@/lib/clients/jellyfin";
import { posterUrl } from "@/lib/images";
import { useRole } from "@/lib/useRole";
import { useToast } from "@/components/Toast";
import { WatchlistButton } from "@/components/WatchlistButton";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";

interface SeriesInfo {
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
  const [selectedActor, setSelectedActor] = useState<{ tmdbId: number; name: string; photoUrl: string | null } | null>(null);
  const seriesKey = `/api/sonarr/series/${id}`;
  const episodesKey = `/api/sonarr/series/${id}/episodes`;

  const { data: series, error, isLoading } = useSWR<SonarrSeries>(seriesKey, fetcher);
  const { data: episodes, error: episodesError } = useSWR<SonarrEpisode[]>(episodesKey, fetcher);
  const { data: meta } = useSWR<{ qualityProfiles: { id: number; name: string }[] }>("/api/sonarr/meta", fetcher);
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

  const [qualityProfileId, setQualityProfileId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [openSeasons, setOpenSeasons] = useState<Set<number>>(new Set());
  const [activeSearch, setActiveSearch] = useState<ActiveSearch | null>(null);
  const [togglingWatched, setTogglingWatched] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const [activeTab, setActiveTab] = useState<"infos" | "casting" | "saisons">("infos");

  useEffect(() => {
    if (series) setQualityProfileId(series.qualityProfileId);
  }, [series]);

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
      await fetch(seriesKey, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...series, ...payload }),
      });
      mutate(seriesKey);
      toast.success("Modifications enregistrées");
    } catch {
      toast.error("Échec de la sauvegarde");
    } finally {
      setSaving(false);
    }
  }

  async function toggleWatched() {
    const jfItem = jfData?.item;
    if (!jfItem) return;
    const newPlayed = !jfItem.UserData?.Played;
    setTogglingWatched(true);
    try {
      const res = await fetch("/api/jellyfin/played", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: jfItem.Id, played: newPlayed }),
      });
      if (!res.ok) throw new Error();
      mutateJf();
      toast.success(newPlayed ? "Série marquée comme vue" : "Série marquée comme non vue");
    } catch {
      toast.error("Échec — vérifiez votre connexion Jellyfin");
    } finally {
      setTogglingWatched(false);
    }
  }

  async function toggleSeasonMonitored(seasonNumber: number, value: boolean) {
    if (!series?.seasons) return;
    const seasons = series.seasons.map((s) =>
      s.seasonNumber === seasonNumber ? { ...s, monitored: value } : s
    );
    await saveSeries({ seasons });
  }

  async function toggleEpisodeMonitored(episode: SonarrEpisode, value: boolean) {
    await fetch(`/api/sonarr/episodes/${episode.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...episode, monitored: value }),
    });
    mutate(episodesKey);
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
      toast.success(`Demande envoyée pour « ${series.title} »`);
    } catch {
      toast.error("Échec de la demande");
    } finally {
      setRequesting(false);
    }
  }

  if (isLoading) return <LoadingState />;
  if (error || !series) return <ErrorState message={error?.message || "Série introuvable."} />;

  const seasonNumbers = [...episodesBySeason.keys()].sort((a, b) => a - b);
  const overview = info?.tmdb?.overview || series.overview;
  const backdrop = info?.tmdb?.backdropUrl;
  const jfItem = jfData?.item;
  const isWatched = jfItem?.UserData?.Played ?? false;
  const canRequest = !jsData || jsData.status === 1;

  return (
    <div className="relative -mx-4 -mt-4 sm:-mx-6 sm:-mt-6 md:-mx-8 md:-mt-6">

      {/* ── Backdrop — natural 16:9 ratio, absolute so it never clips, gradient fades to bg ── */}
      {backdrop && (
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={backdrop} alt="" className="h-full w-full object-cover object-top animate-fade-in" />
          <div className="absolute inset-0 bg-gradient-to-r from-slate-950/60 via-slate-950/10 to-transparent" />
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, rgba(15,23,42,0.03) 0%, rgba(15,23,42,0.18) 18%, rgba(15,23,42,0.50) 35%, rgba(15,23,42,0.82) 52%, rgba(15,23,42,0.96) 65%, rgb(15,23,42) 72%)",
            }}
          />
        </div>
      )}

      {/* ── Navigation zone ── */}
      <div className="relative h-[32vw] min-h-[180px] max-h-[380px] xl:max-h-[520px]">
        <button
          onClick={() => router.back()}
          className="absolute left-4 top-4 sm:left-6 md:left-8 flex items-center gap-1.5 rounded-lg bg-black/40 px-3 py-1.5 text-xs text-white backdrop-blur-sm hover:bg-black/60"
        >
          <ArrowLeft size={14} /> Retour
        </button>
        {jfItem && (
          <a
            href={`/api/jellyfin/redirect?itemId=${jfItem.Id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute right-4 top-4 sm:right-6 md:right-8 flex items-center gap-1.5 rounded-lg bg-black/40 px-3 py-1.5 text-xs text-white backdrop-blur-sm hover:bg-black/60"
          >
            <ExternalLink size={14} /> Voir sur Jellyfin
          </a>
        )}
      </div>

      {/* ── Poster + Metadata ── */}
      <div className="relative -mt-16 px-4 pb-6 sm:-mt-20 sm:px-6 md:px-8">
        <div className="flex max-w-4xl items-end gap-4 sm:gap-6">
          <div className="hidden shrink-0 sm:block">
            <div className="h-[132px] w-[88px] overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10 md:h-[168px] md:w-28">
              {poster(series) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={poster(series)!} alt={series.title} className="h-full w-full object-cover" />
              ) : null}
            </div>
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="mb-1 text-xl font-bold leading-tight text-white drop-shadow sm:text-2xl md:text-3xl">
              {series.title}
              <span className="ml-2 text-base font-normal text-white/60 md:text-lg">({series.year})</span>
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              {info?.imdbRating && (
                <span className="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-400">
                  <Star size={11} className="fill-current" /> {info.imdbRating}
                </span>
              )}
              {info?.tmdb?.runtime && (
                <span className="text-xs text-white/60">{info.tmdb.runtime} min/ép.</span>
              )}
              {info?.tmdb?.genres.slice(0, 3).map((g) => (
                <span key={g} className="badge bg-white/10 text-white/70 backdrop-blur-sm">{g}</span>
              ))}
              {jfItem && (
                <span className={`badge ${isWatched ? "bg-emerald-500/25 text-emerald-300" : "bg-white/10 text-white/60"}`}>
                  {isWatched ? "Vue" : "Non vue"}
                </span>
              )}
              {jsData && <JellyseerrBadge status={jsData.status} />}
            </div>
          </div>
        </div>
      </div>

      {/* ── Content below — backdrop fully faded behind the file card ── */}
      <div className="relative px-4 sm:px-6 md:px-8">
      <div className="max-w-4xl">

      {/* ── Action buttons ─────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {!isGuest && jfItem && (
          <button
            className={`btn-ghost px-3 ${isWatched ? "text-emerald-400" : "text-slate-400"}`}
            onClick={toggleWatched}
            disabled={togglingWatched}
          >
            {isWatched ? <Eye size={16} /> : <EyeOff size={16} />}
            {isWatched ? "Vue" : "Marquer vue"}
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
            className="btn-secondary px-3"
            onClick={requestSeries}
            disabled={requesting}
          >
            <Send size={14} />
            {requesting ? "En cours…" : "Demander"}
          </button>
        )}
        {info?.trailerKey && (
          <button className="btn-ghost px-3" onClick={() => setShowTrailer(true)}>
            <PlayCircle size={16} /> Bande-annonce
          </button>
        )}
        {!isGuest && (
          <button
            className="btn-primary"
            onClick={() => setActiveSearch({ title: `Recherche · ${series.title}`, endpoint: `/api/sonarr/series/${id}/releases` })}
          >
            <Search size={16} /> Recherche interactive
          </button>
        )}
      </div>

      {/* ── Mobile tab bar ─────────────────────────────────────── */}
      <div className="mb-4 flex rounded-xl border border-white/10 bg-white/5 p-1 md:hidden">
        {(["infos", "casting", "saisons"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); haptic(30); }}
            className={`flex-1 rounded-lg py-1.5 text-xs font-medium capitalize transition-colors ${
              activeTab === tab ? "bg-white/15 text-white" : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {tab === "infos" ? "Infos" : tab === "casting" ? "Casting" : "Saisons"}
          </button>
        ))}
      </div>

      {/* ── Tagline + Overview ──────────────────────────────────── */}
      <div className={activeTab !== "infos" ? "hidden md:block" : ""}>
      {info?.tmdb?.tagline && (
        <p className="mb-2 text-sm italic text-slate-500">{info.tmdb.tagline}</p>
      )}
      {overview && <p className="mb-6 max-w-2xl text-sm text-slate-400">{overview}</p>}

      {/* ── Settings card ──────────────────────────────────────── */}
      {isGuest ? (
        <div className="card mb-6 flex flex-wrap items-center gap-4 p-4 text-sm text-slate-300">
          <span className="badge bg-white/5">{series.monitored ? "Surveillé" : "Non surveillé"}</span>
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
            label="Surveillé"
          />
          <label className="flex items-center gap-2 text-sm text-slate-300">
            Profil qualité
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
        </div>
      )}

      </div>{/* end infos tab */}

      {/* ── Cast ────────────────────────────────────────────────── */}
      <div className={activeTab !== "casting" ? "hidden md:block" : ""}>
      {info?.tmdb?.cast && info.tmdb.cast.length > 0 && (
        <Collapsible title="Casting" badge={info.tmdb.cast.length} icon={<Tv size={15} className="text-accent-400" />} className="mb-6">
          <HorizontalCarousel className="scrollbar-thin flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
            {info.tmdb.cast.map((actor) => {
              const isVip = actor.tmdbId === 3247402;
              return (
                <button
                  key={actor.tmdbId}
                  className="w-20 shrink-0 snap-start text-center [touch-action:manipulation]"
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
      <h2 className="mb-3 text-sm font-semibold text-white">Saisons</h2>
      {episodesError && <ErrorState message="Impossible de charger les épisodes." />}

      <div className="space-y-2">
            {seasonNumbers.map((seasonNumber) => {
              const seasonEpisodes = episodesBySeason.get(seasonNumber) ?? [];
              const seasonMeta = series.seasons?.find((s) => s.seasonNumber === seasonNumber);
              const fileCount = seasonEpisodes.filter((e) => e.hasFile).length;
              const open = openSeasons.has(seasonNumber);

              return (
                <div key={seasonNumber} className="card overflow-hidden">
                  <div
                    className="flex cursor-pointer items-center justify-between p-3"
                    onClick={() => toggleSeasonOpen(seasonNumber)}
                  >
                    <div className="flex items-center gap-2 text-sm text-white">
                      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      Saison {seasonNumber === 0 ? "spéciale" : seasonNumber}
                      <span className="text-xs text-slate-500">
                        {fileCount}/{seasonEpisodes.length} épisodes
                      </span>
                    </div>
                    <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                      {isGuest ? (
                        <span className="badge bg-white/5 text-xs">
                          {seasonMeta?.monitored ? "Surveillé" : "Non surveillé"}
                        </span>
                      ) : (
                        <>
                          <button
                            className="btn-ghost px-2 py-1 text-xs"
                            onClick={() =>
                              setActiveSearch({
                                title: `Recherche · Saison ${seasonNumber}`,
                                endpoint: `/api/sonarr/series/${id}/releases?seasonNumber=${seasonNumber}`,
                              })
                            }
                          >
                            <Search size={12} /> Rechercher
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
                        return (
                          <div key={ep.id} className="flex flex-col gap-1.5 p-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-2">
                                {isGuest ? (
                                  ep.monitored ? (
                                    <CheckCircle2 size={16} className="text-accent-400" />
                                  ) : (
                                    <Circle size={16} className="text-slate-600" />
                                  )
                                ) : (
                                  <button onClick={() => toggleEpisodeMonitored(ep, !ep.monitored)}>
                                    {ep.monitored ? (
                                      <CheckCircle2 size={16} className="text-accent-400" />
                                    ) : (
                                      <Circle size={16} className="text-slate-600" />
                                    )}
                                  </button>
                                )}
                                <span className="text-slate-500">{ep.episodeNumber}.</span>
                                <span className="truncate text-slate-200">{ep.title}</span>
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                {ep.airDate && <span className="text-xs text-slate-500">{ep.airDate}</span>}
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${ep.hasFile ? "bg-emerald-400" : "bg-amber-400"}`}
                                />
                                {!isGuest && (
                                <button
                                  className="btn-ghost px-2 py-1"
                                  onClick={() =>
                                    setActiveSearch({
                                      title: `Recherche · ${ep.title}`,
                                      endpoint: `/api/sonarr/series/${id}/releases?episodeId=${ep.id}`,
                                    })
                                  }
                                >
                                  <Search size={12} />
                                </button>
                                )}
                              </div>
                            </div>
                            {(subs?.subtitles?.length || download) && (
                              <div className="ml-6 flex flex-wrap items-center gap-1.5">
                                {subs?.subtitles?.map((s, i) => (
                                  <span key={i} className="badge bg-white/5 text-[11px] text-slate-400">
                                    <Captions size={10} /> {s.name}
                                  </span>
                                ))}
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
        <TrailerModal youtubeKey={info.trailerKey} title={`${series.title} — Bande-annonce`} onClose={() => setShowTrailer(false)} />
      )}
      {activeSearch && (
        <ReleaseSearchModal
          title={activeSearch.title}
          searchEndpoint={activeSearch.endpoint}
          grabEndpoint="/api/sonarr/releases"
          onClose={() => setActiveSearch(null)}
        />
      )}
      </div>{/* end max-w-4xl */}
      </div>{/* end px wrapper */}
    </div>
  );
}

const JS_STATUS: Record<number, { label: string; cls: string }> = {
  2: { label: "En attente", cls: "bg-amber-500/20 text-amber-400" },
  3: { label: "En traitement", cls: "bg-blue-500/20 text-blue-400" },
  4: { label: "Partiel", cls: "bg-sky-500/20 text-sky-400" },
  5: { label: "Disponible", cls: "bg-emerald-500/20 text-emerald-400" },
};

function JellyseerrBadge({ status }: { status: number }) {
  const s = JS_STATUS[status];
  if (!s) return null;
  return <span className={`badge backdrop-blur-sm ${s.cls}`}>{s.label}</span>;
}

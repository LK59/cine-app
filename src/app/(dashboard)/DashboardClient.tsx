"use client";

import Link from "next/link";
import { useState } from "react";
import { PlayButton } from "@/components/PlayButton";
import { usePlayback } from "@/components/PlaybackProvider";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { INTERVALS } from "@/lib/refresh-intervals";
import { LoadingState, EmptyState } from "@/components/StateViews";
import { Film, Tv, Captions, Search, Download, PlayCircle, ListChecks, Inbox, Image, Star, HardDrive, Clock, Zap, RefreshCw, AlertTriangle, ExternalLink, Play, ChevronRight, CirclePlus } from "lucide-react";
import { useRole } from "@/lib/useRole";
import { useT } from "@/components/TranslationProvider";
import { PosterImage } from "@/components/PosterImage";
import { ImdbBadge } from "@/components/ImdbBadge";
import { DashboardHero } from "@/components/DashboardHero";
import { RequestButton } from "@/components/RequestButton";
import { RequestFlowModal } from "@/components/RequestFlowModal";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { CarouselSkeleton } from "@/components/SkeletonCard";
import { ActionSheet } from "@/components/ActionSheet";
import { useLongPress } from "@/hooks/useLongPress";
import { useTvGridNav } from "@/lib/useTvGridNav";
import type { DashboardPayload, ServiceStatus, ActivityItem, ResumeItem, RecentItem, TorrentItem } from "@/app/api/dashboard/route";
import type { DiskStats } from "@/lib/disk-stats";
import type { WatchlistItem } from "@/lib/db";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";

import { fmtSize, relativeTime, relativeTimeAbs, formatResumeTicks } from "@/lib/format";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_COLOR: Record<string, string> = {
  radarr: "bg-accent-600/15 text-accent-400",
  sonarr: "bg-sky-600/15 text-sky-400",
  jellyseerr: "bg-emerald-600/15 text-emerald-400",
};

const SERVICE_META: Record<string, { label: string; icon: React.ElementType; href?: string }> = {
  radarr:       { label: "Radarr",           icon: Film,      href: "/radarr" },
  sonarr:       { label: "Sonarr",           icon: Tv,        href: "/sonarr" },
  bazarr:       { label: "Bazarr",           icon: Captions,  href: "/bazarr" },
  jackett:      { label: "Jackett",          icon: Search,    href: "/jackett" },
  qbittorrent:  { label: "qBittorrent",      icon: Download,  href: "/qbittorrent" },
  jellyfin:     { label: "Jellyfin",         icon: PlayCircle,href: "/jellyfin" },
  jellyseerr:   { label: "Jellyseerr",       icon: ListChecks,href: "/jellyseerr" },
  tmdb:         { label: "TMDb",             icon: Image },
  omdb:         { label: "OMDb (note IMDb)", icon: Star },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionUnavailable({ label, error }: { label: string; error: string | null }) {
  const t = useT();
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-400">
      <AlertTriangle size={14} className="shrink-0" />
      <span><strong>{label}</strong> {t('dashboard.unavailableWord')}{error ? ` — ${error}` : ""}</span>
    </div>
  );
}

function StaleIndicator({ updatedAt }: { updatedAt: number | null }) {
  const t = useT();
  if (!updatedAt) return null;
  return (
    <span className="ml-2 text-[11px] text-slate-600" title={t('common.cachedData')}>
      · {t('common.updatedAt')} {relativeTimeAbs(updatedAt, t)}
    </span>
  );
}

const TV_NAV_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

function ResumeCard({ item, index }: { item: ResumeItem; index: number }) {
  const router = useRouter();
  const t = useT();
  const playback = usePlayback();
  const [open, setOpen] = useState(false);
  const lp = useLongPress(() => setOpen(true));
  const resumeAt = item.positionTicks > 0 ? item.positionTicks / 10_000_000 : undefined;
  const playLabel =
    item.positionTicks > 0 ? `${t('common.resume')} - ${formatResumeTicks(item.positionTicks)}` : t('common.play');

  // Shared by both the Link and div branches below — kept as a single JSX block rather than a
  // separate component so the two wrapper cases can't drift out of sync with each other.
  const cardBody = (
    <>
      <div className="relative">
        <PosterImage
          src={item.imageTag ? `/api/jellyfin/image?itemId=${item.id}&tag=${item.imageTag}` : null}
          alt={item.name}
          unoptimized
        />
        {item.imdbRating && <ImdbBadge rating={item.imdbRating} className="absolute left-1.5 top-1.5 shadow" />}
        {/* A dark gradient behind the bar guarantees contrast against any poster art —
            the previous bar (h-1, bg-black/50) could nearly disappear over a light poster.
            Track lightened (white/25 vs. black/50) so the unfilled portion reads clearly too,
            not just the filled one. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/80 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-white/25">
          <div className="h-full bg-accent-500 shadow-[0_0_4px_rgba(0,0,0,0.6)]" style={{ width: `${item.progress}%` }} />
        </div>
      </div>
      <div className="p-2">
        <p className="truncate text-xs font-medium text-white">{item.name}</p>
        {item.subtitle && <p className="truncate text-[11px] text-slate-500">{item.subtitle}</p>}
        <div className="mt-1.5 flex gap-1">
          <PlayButton
            itemId={item.id}
            title={item.name}
            resumeTicks={item.positionTicks}
            runtimeTicks={item.runtimeTicks}
            variant="icon"
            iconSize={13}
            className="rounded-sm bg-accent-600/80 px-2 py-1 text-white hover:bg-accent-600"
          />
          {/* A plain <a> here would nest an anchor inside the card's own Link below — browsers
              auto-close the outer anchor when they hit a nested one, breaking its navigation
              entirely. A button + window.open() (identical to the ActionSheet's own "Jellyfin"
              action just below) sidesteps that without changing the visible behavior at all. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              window.open(`/api/jellyfin/redirect?itemId=${item.id}`, "_blank");
            }}
            className="flex-1 rounded-sm bg-accent-600/20 px-2 py-1 text-center text-[11px] text-accent-400 hover:bg-accent-600/30"
          >
            Jellyfin
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Whole card opens the sheet on click — the separate "Fiche" text link this replaced
          is gone, its destination is now just clicking the card. Only when a Radarr/Sonarr
          mapping actually exists (cinemaHref): a pure-Jellyfin item with no such mapping has
          nowhere else to navigate to and stays a plain, non-navigating div, same as before. */}
      {item.cinemaHref ? (
        <Link
          {...lp}
          href={item.cinemaHref}
          data-tv-card
          data-tv-row="resume"
          data-tv-col={index}
          className={`card-solid w-36 shrink-0 overflow-hidden transition-shadow hover:ring-1 hover:ring-accent-500/40 sm:w-40 touch-manipulation select-none ${TV_NAV_RING}`}
        >
          {cardBody}
        </Link>
      ) : (
        <div
          {...lp}
          className="card-solid w-36 shrink-0 overflow-hidden sm:w-40 touch-manipulation select-none"
        >
          {cardBody}
        </div>
      )}
      <ActionSheet
        open={open}
        onClose={() => setOpen(false)}
        title={item.name}
        subtitle={item.subtitle ?? undefined}
        actions={[
          { label: playLabel, icon: <PlayCircle size={16} />, onClick: () => playback.play({ itemId: item.id, title: item.name, resumeAt }) },
          { label: t('common.openJellyfin'), icon: <Play size={16} />, onClick: () => window.open(`/api/jellyfin/redirect?itemId=${item.id}`, "_blank") },
          ...(item.cinemaHref ? [{ label: t('common.viewSheet'), icon: <ExternalLink size={16} />, onClick: () => router.push(item.cinemaHref!) }] : []),
        ]}
      />
    </>
  );
}

function RecentMovieCard({ m, index }: { m: RecentItem; index: number }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const lp = useLongPress(() => setOpen(true));
  return (
    <>
      <Link
        {...lp}
        href={`/radarr/${m.id}`}
        data-tv-card
        data-tv-row="recent-movies"
        data-tv-col={index}
        className={`card-solid w-28 shrink-0 overflow-hidden transition-shadow hover:ring-1 hover:ring-accent-500/40 touch-manipulation select-none ${TV_NAV_RING}`}
      >
        <div className="relative">
          <PosterImage src={m.posterUrl} alt={m.title} />
          {m.imdbRating && <ImdbBadge rating={m.imdbRating} className="absolute left-1.5 top-1.5 shadow" />}
          {m.hasFile && <div className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400" title={t('dashboard.downloadedTooltip')} />}
        </div>
        <div className="p-2">
          <p className="truncate text-xs font-medium text-white">{m.title}</p>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500"><Clock size={9} />{relativeTime(m.added!, t)}</div>
        </div>
      </Link>
      <ActionSheet
        open={open}
        onClose={() => setOpen(false)}
        title={m.title}
        poster={m.posterUrl}
        actions={[
          { label: t('common.viewSheet'), icon: <ExternalLink size={16} />, onClick: () => router.push(`/radarr/${m.id}`) },
        ]}
      />
    </>
  );
}

function RecentSeriesCard({ s, index }: { s: RecentItem; index: number }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const lp = useLongPress(() => setOpen(true));
  return (
    <>
      <Link
        {...lp}
        href={`/sonarr/${s.id}`}
        data-tv-card
        data-tv-row="recent-series"
        data-tv-col={index}
        className={`card-solid w-28 shrink-0 overflow-hidden transition-shadow hover:ring-1 hover:ring-sky-500/40 touch-manipulation select-none ${TV_NAV_RING}`}
      >
        <div className="relative">
          <PosterImage src={s.posterUrl} alt={s.title} />
          {s.imdbRating && <ImdbBadge rating={s.imdbRating} className="absolute left-1.5 top-1.5 shadow" />}
        </div>
        <div className="p-2">
          <p className="truncate text-xs font-medium text-white">{s.title}</p>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500"><Clock size={9} />{relativeTime(s.added!, t)}</div>
        </div>
      </Link>
      <ActionSheet
        open={open}
        onClose={() => setOpen(false)}
        title={s.title}
        poster={s.posterUrl}
        actions={[
          { label: t('common.viewSheet'), icon: <ExternalLink size={16} />, onClick: () => router.push(`/sonarr/${s.id}`) },
        ]}
      />
    </>
  );
}

function SkeletonSection() {
  return (
    <>
      <div className="mb-3 h-4 w-44 rounded-md bg-slate-800 animate-pulse" />
      <HorizontalCarousel className="mb-8 flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
        <CarouselSkeleton count={4} width="w-36" />
      </HorizontalCarousel>
      <div className="mb-3 h-4 w-52 rounded-md bg-slate-800 animate-pulse" />
      <div className="mb-2 h-3 w-10 rounded-sm bg-slate-800 animate-pulse" />
      <HorizontalCarousel className="mb-5 flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
        <CarouselSkeleton count={6} width="w-28" />
      </HorizontalCarousel>
      <div className="mb-2 h-3 w-10 rounded-sm bg-slate-800 animate-pulse" />
      <HorizontalCarousel className="mb-8 flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
        <CarouselSkeleton count={6} width="w-28" />
      </HorizontalCarousel>
    </>
  );
}

function ResumeSection({ items }: { items: ResumeItem[] }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <>
      <h2 className="mb-3 text-sm font-semibold text-white">{t('dashboard.resumeWatching')}</h2>
      <HorizontalCarousel className="mb-8 flex gap-3 overflow-x-auto pb-2 scrollbar-thin snap-x snap-mandatory">
        {items.map((item, i) => <ResumeCard key={item.id} item={item} index={i} />)}
      </HorizontalCarousel>
    </>
  );
}

function RecentSection({ movies, series }: { movies: RecentItem[] | null; series: RecentItem[] | null }) {
  const t = useT();
  if (!movies?.length && !series?.length) return null;
  return (
    <>
      <h2 className="mb-3 text-sm font-semibold text-white">{t('dashboard.recentlyAdded')}</h2>
      {movies && movies.length > 0 && (
        <div className="mb-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs text-slate-500"><Film size={12} /> {t('common.movies')}</p>
            <Link href="/radarr" className="flex items-center gap-0.5 text-xs text-slate-500 hover:text-slate-300">
              {t('dashboard.seeAll')} <ChevronRight size={13} />
            </Link>
          </div>
          <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin snap-x snap-mandatory">
            {movies.map((m, i) => <RecentMovieCard key={m.id} m={m} index={i} />)}
          </HorizontalCarousel>
        </div>
      )}
      {series && series.length > 0 && (
        <div className="mb-8">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs text-slate-500"><Tv size={12} /> {t('common.seriesPlural')}</p>
            <Link href="/sonarr" className="flex items-center gap-0.5 text-xs text-slate-500 hover:text-slate-300">
              {t('dashboard.seeAll')} <ChevronRight size={13} />
            </Link>
          </div>
          <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin snap-x snap-mandatory">
            {series.map((s, i) => <RecentSeriesCard key={s.id} s={s} index={i} />)}
          </HorizontalCarousel>
        </div>
      )}
    </>
  );
}

function WatchlistTeaserCard({ item, href, index, imdbRating }: { item: WatchlistItem; href: string | null; index: number; imdbRating: string | null }) {
  const t = useT();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const poster = item.posterPath
    ? item.posterPath.startsWith("http") ? item.posterPath : `${TMDB_IMAGE_BASE}/w342${item.posterPath}`
    : null;
  const body = (
    <>
      <div className="relative">
        <PosterImage src={poster} alt={item.title} />
        {imdbRating && <ImdbBadge rating={imdbRating} className="absolute left-1.5 top-1.5 shadow" />}
      </div>
      <div className="p-2">
        <p className="truncate text-xs font-medium text-white">{item.title}</p>
        {item.year && <p className="text-[11px] text-slate-500">{item.year}</p>}
      </div>
    </>
  );
  // Only clickable once the item is actually in the library (Radarr/Sonarr) — a pure "à voir"
  // wish-list entry with nothing downloaded yet has no sheet of its own to open, same fallback
  // as ResumeCard for items without a cinemaHref.
  return href ? (
    <Link
      href={href}
      data-tv-card
      data-tv-row="watchlist"
      data-tv-col={index}
      className={`card-solid w-28 shrink-0 overflow-hidden transition-shadow hover:ring-1 hover:ring-accent-500/40 touch-manipulation select-none ${TV_NAV_RING}`}
    >
      {body}
    </Link>
  ) : (
    // Not in the library yet — a static, unclickable poster here was dead weight (nothing to
    // open). Desktop keeps the hover overlay (real :hover, plus group-focus-within as the Tab-key
    // fallback) with the same RequestButton as the /watchlist page. Touch devices have no hover
    // state at all, so that overlay was simply unreachable there — a plain tap on the card opens
    // a one-action ActionSheet instead (same underlying RequestFlowModal either way). Deliberately
    // NOT the long-press gesture the resume/recent cards use elsewhere: on a poster image, iOS's
    // own long-press (save-image / link-preview) gesture fires at the same delay and the two
    // fought each other.
    <>
      <div
        onClick={() => setSheetOpen(true)}
        className="group card relative w-28 shrink-0 overflow-hidden touch-manipulation select-none"
      >
        {body}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/70 opacity-0 backdrop-blur-xs transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <RequestButton mediaType={item.mediaType} tmdbId={item.tmdbId} title={item.title} />
        </div>
      </div>
      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={item.title}
        subtitle={item.year ? String(item.year) : undefined}
        poster={poster}
        actions={[
          {
            label: requested ? t('common.requested') : t('common.request'),
            icon: <CirclePlus size={16} />,
            disabled: requested,
            onClick: () => setRequestOpen(true),
          },
        ]}
      />
      {requestOpen && (
        <RequestFlowModal
          mediaType={item.mediaType}
          tmdbId={item.tmdbId}
          title={item.title}
          onClose={() => setRequestOpen(false)}
          onSuccess={() => setRequested(true)}
        />
      )}
    </>
  );
}

// Home teaser for the watchlist — deliberately only the "to_watch" status (not favorites/
// watched/etc.), matching what Louis actually asked for: a quick-glance row of what's queued
// up next, not the whole watchlist (that's what the dedicated /watchlist page is for).
function WatchlistSection() {
  const t = useT();
  const { data } = useSWR<{ items: WatchlistItem[] }>("/api/watchlist?status=to_watch", fetcher);
  const { data: libMap } = useSWR<{
    movieMap: Record<number, number>;
    seriesMap: Record<number, number>;
  }>("/api/library/map", fetcher, { revalidateOnFocus: false });
  const items = data?.items ?? [];

  const ratingsKey = items.length > 0
    ? `/api/watchlist/ratings?items=${items.map((i) => `${i.mediaType}:${i.tmdbId}`).join(",")}`
    : null;
  const { data: ratingsMap } = useSWR<Record<string, string | null>>(ratingsKey, fetcher, { revalidateOnFocus: false });

  if (items.length === 0) return null;

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{t('dashboard.myList')}</h2>
        <Link href="/watchlist" className="flex items-center gap-0.5 text-xs text-slate-500 hover:text-slate-300">
          {t('dashboard.seeAll')} <ChevronRight size={13} />
        </Link>
      </div>
      <HorizontalCarousel className="mb-8 flex gap-3 overflow-x-auto pb-2 scrollbar-thin snap-x snap-mandatory">
        {items.slice(0, 20).map((item, i) => {
          const id = item.mediaType === "movie" ? libMap?.movieMap[item.tmdbId] : libMap?.seriesMap[item.tmdbId];
          const href = id ? (item.mediaType === "movie" ? `/radarr/${id}` : `/sonarr/${id}`) : null;
          return (
            <WatchlistTeaserCard
              key={`${item.mediaType}:${item.tmdbId}`}
              item={item}
              href={href}
              index={i}
              imdbRating={ratingsMap?.[`${item.mediaType}:${item.tmdbId}`] ?? null}
            />
          );
        })}
      </HorizontalCarousel>
    </>
  );
}

function TorrentsSection({ torrents }: { torrents: TorrentItem[] }) {
  const t = useT();
  const active = torrents.filter((item) => ["downloading", "stalledDL", "metaDL", "forcedDL"].includes(item.state));
  if (!active.length) return null;
  const shown = active.slice(0, 4);
  return (
    <>
      <h2 className="mb-3 text-sm font-semibold text-white">{t('dashboard.activeDownloads')}</h2>
      <div className="mb-8 card divide-y divide-white/5">
        {shown.map((torrent) => {
          const pct = Math.round(torrent.progress * 100);
          const speed = torrent.dlspeed > 0 ? `${fmtSize(torrent.dlspeed)}/s` : null;
          const eta = torrent.eta > 0 && torrent.eta < 86400 * 7
            ? torrent.eta < 3600 ? `${Math.ceil(torrent.eta / 60)} min` : `${(torrent.eta / 3600).toFixed(1)} h`
            : null;
          return (
            <div key={torrent.hash} className="p-3">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <p className="truncate text-xs font-medium text-white">{torrent.name}</p>
                <span className="shrink-0 text-[11px] text-slate-500">{pct}%</span>
              </div>
              <div className="mb-1 h-1 w-full rounded-full bg-slate-800">
                <div className="h-1 rounded-full bg-accent-500 transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-500">
                {speed && <span className="flex items-center gap-0.5"><Zap size={9} />{speed}</span>}
                {eta && <span>ETA {eta}</span>}
                {torrent.state === "stalledDL" && <span className="text-amber-500">{t('dashboard.waitingSeeds')}</span>}
              </div>
            </div>
          );
        })}
        {active.length > 4 && (
          <div className="p-3 text-center">
            <Link href="/qbittorrent" className="text-xs text-slate-500 hover:text-slate-300">
              {t('dashboard.showMore', { n: String(active.length - 4) })}
            </Link>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * L'état de la pile, en un panneau plutôt qu'en neuf briques.
 *
 * C'était une grille de tuiles : chacune portait son cadre, son icône encadrée, sa pastille
 * « En ligne » qui passait à la ligne faute de place, et ses chiffres dans une grille à deux
 * colonnes dont les intitulés se coupaient en trois. Comme les lignes d'une grille s'alignent
 * en hauteur, la tuile la plus fournie fixait la hauteur des autres : Bazarr et Jackett étaient
 * aux trois quarts vides. Et rien ne s'alignait d'une tuile à l'autre, alors que ces neuf
 * services disent exactement la même chose — un nom, une version, des chiffres, un état.
 *
 * Donc : une seule surface, une ligne par service, des colonnes qui se répondent d'une ligne à
 * l'autre. L'état tient dans une pastille de couleur, dit une fois en clair par l'en-tête, et
 * la ligne d'un service tombé se colore en entier avec son erreur à la place de ses chiffres.
 */
function ServicesSection({ services }: { services: ServiceStatus[] }) {
  const t = useT();
  const known = services.filter((s) => SERVICE_META[s.name]);
  const down = known.filter((s) => !s.up);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-white/5 px-4 py-3">
        <p className="text-sm font-semibold text-white">{t("dashboard.servicesStatus")}</p>
        <p className={`text-xs ${down.length > 0 ? "text-red-400" : "text-slate-500"}`}>
          {down.length === 0
            ? t("dashboard.servicesAllUp", { n: String(known.length) })
            : t("dashboard.servicesSomeDown", { n: String(down.length), total: String(known.length) })}
        </p>
      </div>

      <div className="divide-y divide-white/5">
        {known.map((service) => {
          const meta = SERVICE_META[service.name]!;
          const Icon = meta.icon;
          const Tag = (meta.href ? Link : "div") as React.ElementType;
          const entries = Object.entries(service.stats ?? {});
          return (
            <Tag
              key={service.name}
              {...(meta.href ? { href: meta.href } : {})}
              className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${
                service.up ? "" : "bg-red-500/[0.04]"
              } ${meta.href ? "hover:bg-white/[0.04]" : ""}`}
            >
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${service.up ? "bg-emerald-400" : "bg-red-400"}`}
              />
              <Icon size={15} className={`shrink-0 ${service.up ? "text-slate-400" : "text-red-400/80"}`} />

              {/* Largeur fixe à partir de sm : c'est ce qui met les chiffres de neuf services
                  sur la même colonne, ce qu'une grille de tuiles ne peut pas faire. */}
              <div className="min-w-0 shrink-0 sm:w-44">
                <p className="truncate text-[13px] font-medium leading-tight text-white">{meta.label}</p>
                {service.detail && (
                  <p className="truncate text-[11px] leading-tight text-slate-500">{service.detail}</p>
                )}
              </div>

              {service.up ? (
                <div className="hidden min-w-0 flex-1 flex-wrap items-baseline gap-x-4 gap-y-0.5 sm:flex">
                  {entries.map(([label, value]) => (
                    <span key={label} className="flex items-baseline gap-1.5 whitespace-nowrap">
                      <span className="text-[13px] font-semibold tabular-nums text-white">{value}</span>
                      <span className="text-[11px] text-slate-500">{label}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="min-w-0 flex-1 truncate text-[11px] text-red-400" title={service.detail ?? undefined}>
                  {service.detail}
                </p>
              )}

              <span className="ml-auto shrink-0 sr-only">
                {service.up ? t("common.online") : t("common.offline")}
              </span>
              {meta.href && <ChevronRight size={14} className="shrink-0 text-slate-600" />}
            </Tag>
          );
        })}
      </div>

      {/* Sur téléphone les chiffres passent sous leur ligne : les mettre à côté du nom
          reviendrait à les couper en trois, ce que faisaient les tuiles. */}
      <div className="divide-y divide-white/5 border-t border-white/5 sm:hidden">
        {known
          .filter((s) => s.up && Object.keys(s.stats ?? {}).length > 0)
          .map((service) => (
            <div key={service.name} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2">
              <span className="w-full text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                {SERVICE_META[service.name]!.label}
              </span>
              {Object.entries(service.stats ?? {}).map(([label, value]) => (
                <span key={label} className="flex items-baseline gap-1.5 whitespace-nowrap">
                  <span className="text-[13px] font-semibold tabular-nums text-white">{value}</span>
                  <span className="text-[11px] text-slate-500">{label}</span>
                </span>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function DiskSection({ disk, updatedAt, computing }: { disk: DiskStats; updatedAt: number | null; computing: boolean }) {
  const t = useT();
  if (disk.disk.total <= 0 && !computing) return null;
  return (
    <>
      <h2 className="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold text-white">
        {t('dashboard.storageTitle')}
        {computing && <RefreshCw size={12} className="animate-spin text-slate-500" />}
        {updatedAt && !computing && <StaleIndicator updatedAt={updatedAt} />}
      </h2>
      {computing && disk.disk.total <= 0 ? (
        <div className="card mb-6 p-4 text-sm text-slate-500">{t('dashboard.computingStorage')}</div>
      ) : (
        <div className="card mb-6 p-4">
          <div className="mb-4 flex items-center gap-3">
            <HardDrive size={16} className="text-accent-400" />
            <span className="text-sm text-slate-300">{t('dashboard.storageFree', { free: fmtSize(disk.disk.free), total: fmtSize(disk.disk.total) })}</span>
          </div>
          <div className="mb-1 flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
            {disk.moviesBytes > 0 && <div className="h-full bg-accent-500" style={{ width: `${(disk.moviesBytes / disk.disk.total) * 100}%` }} title={t('dashboard.storageFilms', { size: fmtSize(disk.moviesBytes) })} />}
            {disk.tvBytes > 0 && <div className="h-full bg-sky-500" style={{ width: `${(disk.tvBytes / disk.disk.total) * 100}%` }} title={t('dashboard.storageSeries', { size: fmtSize(disk.tvBytes) })} />}
            {disk.seedsBytes > 0 && <div className="h-full bg-amber-500" style={{ width: `${(disk.seedsBytes / disk.disk.total) * 100}%` }} title={t('dashboard.storageSeeds', { size: fmtSize(disk.seedsBytes) })} />}
            {disk.disk.used - disk.moviesBytes - disk.tvBytes - disk.seedsBytes > 0 && <div className="h-full bg-slate-600" style={{ width: `${((disk.disk.used - disk.moviesBytes - disk.tvBytes - disk.seedsBytes) / disk.disk.total) * 100}%` }} title={t('dashboard.storageOther', { size: "" })} />}
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-500" />{t('dashboard.storageFilms', { size: fmtSize(disk.moviesBytes) })}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" />{t('dashboard.storageSeries', { size: fmtSize(disk.tvBytes) })}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />{t('dashboard.storageSeeds', { size: fmtSize(disk.seedsBytes) })}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-600" />{t('dashboard.storageOther', { size: fmtSize(Math.max(0, disk.disk.used - disk.moviesBytes - disk.tvBytes - disk.seedsBytes)) })}</span>
            <span className="ml-auto text-slate-500">{t('dashboard.storageUsed', { pct: ((disk.disk.used / disk.disk.total) * 100).toFixed(1) })}</span>
          </div>
        </div>
      )}
    </>
  );
}

function ActivitySection({ items }: { items: ActivityItem[] }) {
  const t = useT();
  return (
    <>
      <h2 className="mb-3 mt-8 text-sm font-semibold text-white">{t('dashboard.activityTitle')}</h2>
      {items.length === 0 ? (
        <EmptyState label={t('dashboard.noActivity')} />
      ) : (
        <div className="card divide-y divide-white/5">
          {items.map((item) => {
            const content = (
              <div className="flex items-center gap-3 p-3">
                <div className="rounded-lg bg-white/5 p-2 text-slate-400"><Inbox size={14} /></div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">
                    {item.title}{item.detail && <span className="text-slate-500"> · {item.detail}</span>}
                  </p>
                  <p className="text-xs text-slate-500">{relativeTime(item.date, t)}</p>
                </div>
                <span className={`badge ${SOURCE_COLOR[item.source]}`}>{item.type}</span>
              </div>
            );
            return item.href ? (
              <Link key={item.id} href={item.href} className="block hover:bg-white/5">{content}</Link>
            ) : <div key={item.id}>{content}</div>;
          })}
        </div>
      )}
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardClient({ initialData }: { initialData?: DashboardPayload }) {
  const t = useT();
  const { data, isLoading } = useSWR<DashboardPayload>("/api/dashboard", fetcher, {
    refreshInterval: INTERVALS.FAST,
    fallbackData: initialData,
  });
  useTvGridNav();

  return (
    <div>
      {data?.hero.available && data.hero.data && data.hero.data.length > 0 && (
        <DashboardHero items={data.hero.data} />
      )}

      {isLoading && !data && <SkeletonSection />}

      {data && (
        <>
          {/* Continuer à regarder */}
          {data.resume.available && data.resume.data && (
            <ResumeSection items={data.resume.data.items} />
          )}

          {/* Ma liste (statut "à voir" uniquement) */}
          <WatchlistSection />

          {/* Récemment ajouté */}
          <RecentSection
            movies={data.recentMovies.available ? data.recentMovies.data : null}
            series={data.recentSeries.available ? data.recentSeries.data : null}
          />

          {/* Téléchargements */}
          {data.torrents.available && data.torrents.data && !data.torrents.data.length ? null : (
            data.torrents.available && data.torrents.data
              ? <TorrentsSection torrents={data.torrents.data} />
              : <SectionUnavailable label="qBittorrent" error={data.torrents.error} />
          )}

          {/* Services */}
          {data.services.available && data.services.data ? (
            <ServicesSection services={data.services.data} />
          ) : (
            <SectionUnavailable label={t('dashboard.servicesStatus')} error={data.services.error} />
          )}

          {/* Stockage */}
          {data.disk.available && data.disk.data && (
            <DiskSection
              disk={data.disk.data as DiskStats}
              updatedAt={data.disk.updatedAt}
              computing={(data.disk.data as DiskStats).computing}
            />
          )}

          {/* Activité */}
          {data.activity.available && data.activity.data ? (
            <ActivitySection items={data.activity.data} />
          ) : (
            <SectionUnavailable label={t('dashboard.activityTitle')} error={data.activity.error} />
          )}
        </>
      )}
    </div>
  );
}

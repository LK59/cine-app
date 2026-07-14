"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { INTERVALS } from "@/lib/refresh-intervals";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { LoadingState, EmptyState } from "@/components/StateViews";
import { Film, Tv, Captions, Search, Download, PlayCircle, ListChecks, Inbox, Image, Star, HardDrive, Clock, Zap, RefreshCw, AlertTriangle, ExternalLink, Play } from "lucide-react";
import { useRole } from "@/lib/useRole";
import { useT } from "@/components/TranslationProvider";
import { PosterImage } from "@/components/PosterImage";
import { HorizontalCarousel } from "@/components/HorizontalCarousel";
import { CarouselSkeleton } from "@/components/SkeletonCard";
import { ActionSheet } from "@/components/ActionSheet";
import { useLongPress } from "@/hooks/useLongPress";
import type { DashboardPayload, ServiceStatus, ActivityItem, ResumeItem, RecentItem, TorrentItem } from "@/app/api/dashboard/route";
import type { DiskStats } from "@/lib/disk-stats";

import { fmtSize, relativeTime, relativeTimeAbs } from "@/lib/format";

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
      · {t('common.updatedAt')} {relativeTimeAbs(updatedAt)}
    </span>
  );
}

function ResumeCard({ item }: { item: ResumeItem }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const lp = useLongPress(() => setOpen(true));
  return (
    <>
      <div
        {...lp}
        className="card w-36 shrink-0 overflow-hidden sm:w-40 [touch-action:manipulation] select-none"
      >
        <div className="relative">
          <PosterImage
            src={item.imageTag ? `/api/jellyfin/image?itemId=${item.id}&tag=${item.imageTag}` : null}
            alt={item.name}
            unoptimized
          />
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
            <div className="h-full bg-accent-500" style={{ width: `${item.progress}%` }} />
          </div>
        </div>
        <div className="p-2">
          <p className="truncate text-xs font-medium text-white">{item.name}</p>
          {item.subtitle && <p className="truncate text-[11px] text-slate-500">{item.subtitle}</p>}
          <div className="mt-1.5 flex gap-1">
            <a href={`/api/jellyfin/redirect?itemId=${item.id}`} target="_blank" rel="noopener noreferrer"
              className="flex-1 rounded bg-accent-600/20 px-2 py-1 text-center text-[11px] text-accent-400 hover:bg-accent-600/30">
              Jellyfin
            </a>
            {item.cinemaHref && (
              <Link href={item.cinemaHref} className="rounded bg-white/5 px-2 py-1 text-[11px] text-slate-400 hover:bg-white/10">
                {t('dashboard.sheetLink')}
              </Link>
            )}
          </div>
        </div>
      </div>
      <ActionSheet
        open={open}
        onClose={() => setOpen(false)}
        title={item.name}
        subtitle={item.subtitle ?? undefined}
        actions={[
          { label: t('common.openJellyfin'), icon: <Play size={16} />, onClick: () => window.open(`/api/jellyfin/redirect?itemId=${item.id}`, "_blank") },
          ...(item.cinemaHref ? [{ label: t('common.viewSheet'), icon: <ExternalLink size={16} />, onClick: () => router.push(item.cinemaHref!) }] : []),
        ]}
      />
    </>
  );
}

function RecentMovieCard({ m }: { m: RecentItem }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const lp = useLongPress(() => setOpen(true));
  return (
    <>
      <Link {...lp} href={`/radarr/${m.id}`} className="card w-28 shrink-0 overflow-hidden transition-all hover:ring-1 hover:ring-accent-500/40 [touch-action:manipulation] select-none">
        <div className="relative">
          <PosterImage src={m.posterUrl} alt={m.title} />
          {m.hasFile && <div className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400" title={t('dashboard.downloadedTooltip')} />}
        </div>
        <div className="p-2">
          <p className="truncate text-xs font-medium text-white">{m.title}</p>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500"><Clock size={9} />{relativeTime(m.added!)}</div>
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

function RecentSeriesCard({ s }: { s: RecentItem }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const lp = useLongPress(() => setOpen(true));
  return (
    <>
      <Link {...lp} href={`/sonarr/${s.id}`} className="card w-28 shrink-0 overflow-hidden transition-all hover:ring-1 hover:ring-sky-500/40 [touch-action:manipulation] select-none">
        <PosterImage src={s.posterUrl} alt={s.title} />
        <div className="p-2">
          <p className="truncate text-xs font-medium text-white">{s.title}</p>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500"><Clock size={9} />{relativeTime(s.added!)}</div>
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
      <div className="mb-2 h-3 w-10 rounded bg-slate-800 animate-pulse" />
      <HorizontalCarousel className="mb-5 flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
        <CarouselSkeleton count={6} width="w-28" />
      </HorizontalCarousel>
      <div className="mb-2 h-3 w-10 rounded bg-slate-800 animate-pulse" />
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
        {items.map((item) => <ResumeCard key={item.id} item={item} />)}
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
          <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-500"><Film size={12} /> {t('common.movies')}</p>
          <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin snap-x snap-mandatory">
            {movies.map((m) => <RecentMovieCard key={m.id} m={m} />)}
          </HorizontalCarousel>
        </div>
      )}
      {series && series.length > 0 && (
        <div className="mb-8">
          <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-500"><Tv size={12} /> {t('common.seriesPlural')}</p>
          <HorizontalCarousel className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin snap-x snap-mandatory">
            {series.map((s) => <RecentSeriesCard key={s.id} s={s} />)}
          </HorizontalCarousel>
        </div>
      )}
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
                <div className="h-1 rounded-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} />
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

function ServicesSection({ services }: { services: ServiceStatus[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {services.map((service) => {
        const meta = SERVICE_META[service.name];
        if (!meta) return null;
        const Icon = meta.icon;
        const Tag = (meta.href ? Link : "div") as React.ElementType;
        return (
          <Tag key={service.name} {...(meta.href ? { href: meta.href } : {})}
            className={`card flex flex-col gap-3 p-4 ${meta.href ? "transition-transform hover:-translate-y-0.5" : ""}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-white/5 p-2 text-accent-400 ring-1 ring-inset ring-white/10">
                  <Icon size={20} />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">{meta.label}</p>
                  {service.up && service.detail && <p className="text-xs text-slate-500">{service.detail}</p>}
                </div>
              </div>
              <StatusBadge up={service.up} />
            </div>
            {service.up && service.stats && (
              <div className="grid grid-cols-2 gap-2 border-t border-white/5 pt-3">
                {Object.entries(service.stats).map(([label, value]) => (
                  <div key={label}>
                    <p className="text-base font-semibold text-white">{value}</p>
                    <p className="text-[11px] text-slate-500">{label}</p>
                  </div>
                ))}
              </div>
            )}
            {!service.up && service.detail && (
              <p className="truncate border-t border-white/5 pt-3 text-xs text-red-400" title={service.detail}>
                {service.detail}
              </p>
            )}
          </Tag>
        );
      })}
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
            {disk.disk.used - disk.moviesBytes - disk.tvBytes > 0 && <div className="h-full bg-slate-600" style={{ width: `${((disk.disk.used - disk.moviesBytes - disk.tvBytes) / disk.disk.total) * 100}%` }} title={t('dashboard.storageOther', { size: "" })} />}
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-500" />{t('dashboard.storageFilms', { size: fmtSize(disk.moviesBytes) })}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" />{t('dashboard.storageSeries', { size: fmtSize(disk.tvBytes) })}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-600" />{t('dashboard.storageOther', { size: fmtSize(Math.max(0, disk.disk.used - disk.moviesBytes - disk.tvBytes)) })}</span>
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
                  <p className="text-xs text-slate-500">{relativeTime(item.date)}</p>
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

export default function DashboardPage() {
  const t = useT();
  const { data, isLoading } = useSWR<DashboardPayload>("/api/dashboard", fetcher, {
    refreshInterval: INTERVALS.FAST,
  });

  return (
    <div>
      <PageHeader title={t('dashboard.pageTitle')} subtitle={t('dashboard.pageSubtitle')} />

      {isLoading && !data && <SkeletonSection />}

      {data && (
        <>
          {/* Continuer à regarder */}
          {data.resume.available && data.resume.data && (
            <ResumeSection items={data.resume.data.items} />
          )}

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

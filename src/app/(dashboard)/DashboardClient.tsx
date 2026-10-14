"use client";

import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { INTERVALS } from "@/lib/refresh-intervals";
import { EmptyState, ErrorState } from "@/components/StateViews";
import {
  Film,
  Tv,
  Captions,
  Search,
  Download,
  PlayCircle,
  ListChecks,
  Inbox,
  Image,
  Star,
  HardDrive,
  RefreshCw,
  AlertTriangle,
  ChevronRight,
  Zap,
  Radio,
  Users,
  Clapperboard,
  MessageSquareWarning,
  ServerCrash,
  Server,
  PackageCheck,
  ScanSearch,
} from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/activity/parts";
import type { DashboardPayload, ServiceStatus, ActivityItem, TorrentItem } from "@/app/api/dashboard/route";
import type { DiskStats } from "@/lib/disk-stats";
import type { AccountSummary, WeekSignals } from "@/lib/activity/accounts";
import type { ReportSummary } from "@/lib/reports";
import { activityDigest } from "@/lib/activity/summary";
import { ADMIN_REPORTS_KEY } from "@/components/reports/reportCache";
import { fmtSize } from "@/lib/format";
import { RelativeTime } from "@/components/RelativeTime";
import { AnimatedNumber } from "@/lib/useTweenedNumber";
import { ACTIONABLE_CATEGORIES, type LibraryCheckStatus } from "@/lib/libraryCheck/types";

/**
 * L'accueil de la gestion — un tableau de bord d'administrateur (13/10/2026, DECISIONS.md §81).
 *
 * C'était une seconde vitrine du catalogue : bannière tournante, Reprendre, Ma liste, ajouts
 * récents en affiches. Tout cela est au cinéma, pour tous les comptes ; ici, l'administrateur vient
 * voir ce qui tourne. Dans l'ordre : ce qui se télécharge, l'état des services, le disque, et le
 * résumé de l'Activité du cinéma (comptes, séances, signalements, erreurs) — chaque chiffre lu aux
 * mêmes routes que les pages qui le détaillent, rien de calculé à part.
 */

// Les genres que le serveur envoie (`ActivityKind`) ; un événement imprévu garde son nom brut.
const ACTIVITY_KINDS = new Set(["grabbed", "imported", "deleted", "downloadFailed", "request"]);

const SOURCE_ICON: Record<string, React.ElementType> = { radarr: Film, sonarr: Tv, jellyseerr: ListChecks };

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

/** L'adresse du panneau Activité, dans le cinéma (`#activite=…`, voir `activity/nav.tsx`). */
const ACTIVITY_HREF = "/#activite=1";
/** Configuration → Connexions, où se branche un service ; et Déploiement, pour le dossier des médias. */
const CONNECTIONS_HREF = "/parametres";
const DEPLOYMENT_HREF = "/parametres/deploiement";

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionUnavailable({ label, error }: { label: string; error: string | null }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning">
      <AlertTriangle size={14} className="shrink-0" />
      <span><strong>{label}</strong> {t('dashboard.unavailableWord')}{error ? ` — ${error}` : ""}</span>
    </div>
  );
}

function StaleIndicator({ updatedAt }: { updatedAt: number | null }) {
  const t = useT();
  if (!updatedAt) return null;
  return (
    <span className="text-[11px] font-normal text-subtle" title={t('common.cachedData')}>
      · {t('common.updatedAt')} <RelativeTime date={updatedAt} />
    </span>
  );
}

function SkeletonPanels() {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card h-40 animate-pulse" />
      ))}
    </div>
  );
}

/** Les téléchargements en cours — une ligne chacun, quatre au plus, la suite chez qBittorrent. */
function TorrentsSection({ torrents }: { torrents: TorrentItem[] }) {
  const t = useT();
  const active = torrents.filter((item) => ["downloading", "stalledDL", "metaDL", "forcedDL"].includes(item.state));
  const shown = active.slice(0, 4);
  return (
    <Panel
      title={t('dashboard.activeDownloads')}
      icon={Download}
      action={
        <Link href="/qbittorrent" className="flex items-center gap-0.5 text-xs text-subtle hover:text-muted">
          {active.length > 4 ? t('dashboard.showMore', { n: String(active.length - 4) }) : t('dashboard.open')}
          <ChevronRight size={13} />
        </Link>
      }
    >
      {active.length === 0 ? (
        <p className="px-4 py-6 text-sm text-subtle">{t('dashboard.noDownloads')}</p>
      ) : (
        <div className="divide-y divide-white/5">
          {shown.map((torrent) => {
            const pct = Math.round(torrent.progress * 100);
            const speed = torrent.dlspeed > 0 ? `${fmtSize(torrent.dlspeed)}/s` : null;
            const eta = torrent.eta > 0 && torrent.eta < 86400 * 7
              ? torrent.eta < 3600 ? `${Math.ceil(torrent.eta / 60)} min` : `${(torrent.eta / 3600).toFixed(1)} h`
              : null;
            return (
              <div key={torrent.hash} className="px-4 py-3">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <p className="truncate text-xs font-medium text-white">{torrent.name}</p>
                  <span className="shrink-0 text-[11px] tabular-nums text-subtle">{pct}%</span>
                </div>
                <div className="mb-1 h-1 w-full rounded-full bg-white/10">
                  <div className="h-1 rounded-full bg-accent-500 transition-[width]" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex items-center gap-2 text-[11px] text-subtle">
                  {speed && <span className="flex items-center gap-0.5"><Zap size={10} />{speed}</span>}
                  {eta && <span>ETA {eta}</span>}
                  {torrent.state === "stalledDL" && <span className="text-warning">{t('dashboard.waitingSeeds')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/**
 * L'état des services, en un panneau plutôt qu'en neuf briques.
 *
 * C'était une grille de tuiles : chacune portait son cadre, son icône encadrée, sa pastille
 * « En ligne » qui passait à la ligne faute de place, et ses chiffres dans une grille à deux
 * colonnes dont les intitulés se coupaient en trois. Une seule surface, une ligne par service :
 * l'état tient dans une pastille de couleur, dit une fois en clair par l'en-tête, et la ligne d'un
 * service tombé se colore en entier avec son erreur à la place de ses chiffres.
 */
function ServicesSection({ services }: { services: ServiceStatus[] }) {
  const t = useT();
  // Un service non configuré n'est ni « en ligne » ni « hors ligne » (13/10/2026) : une installation
  // neuve lisait « 9 sur 9 hors ligne », chaque ligne en rouge. Il est nommé à part, sous la liste,
  // avec le chemin vers Configuration → Connexions.
  const all = services.filter((s) => SERVICE_META[s.name]);
  const known = all.filter((s) => s.configured !== false);
  const unconfigured = all.filter((s) => s.configured === false);
  const down = known.filter((s) => !s.up);

  return (
    <Panel
      title={t("dashboard.servicesStatus")}
      icon={Server}
      action={
        <p className={`text-xs ${down.length > 0 ? "text-danger" : "text-subtle"}`}>
          {known.length === 0
            ? t("dashboard.servicesNoneConfigured")
            : down.length === 0
            ? t("dashboard.servicesAllUp", { n: String(known.length) })
            : t("dashboard.servicesSomeDown", { n: String(down.length), total: String(known.length) })}
        </p>
      }
    >
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
              className={`block px-4 py-2.5 transition-colors ${service.up ? "" : "bg-danger/5"} ${meta.href ? "hover:bg-white/4" : ""}`}
            >
              <div className="flex items-center gap-3">
                <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${service.up ? "bg-success" : "bg-danger"}`} />
                <Icon size={15} className={`shrink-0 ${service.up ? "text-muted" : "text-danger"}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium leading-tight text-white">
                    {meta.label}
                    {service.detail && service.up && <span className="ml-2 text-[11px] font-normal text-subtle">{service.detail}</span>}
                  </p>
                </div>
                <span className="sr-only">{service.up ? t("common.online") : t("common.offline")}</span>
                {meta.href && <ChevronRight size={14} className="shrink-0 text-subtle" />}
              </div>
              {/* Les chiffres sous le nom, sur toutes les largeurs : la carte partage maintenant la
                  ligne avec une autre au bureau, et une colonne à côté du nom s'y coupait. */}
              {service.up ? (
                entries.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 pl-[2.1rem]">
                    {entries.map(([label, value]) => (
                      <span key={label} className="flex items-baseline gap-1.5 whitespace-nowrap">
                        <span className="text-[13px] font-semibold tabular-nums text-white">{typeof value === "number" ? <AnimatedNumber value={value} /> : value}</span>
                        <span className="text-[11px] text-subtle">{label}</span>
                      </span>
                    ))}
                  </div>
                )
              ) : (
                <p className="mt-0.5 truncate pl-[2.1rem] text-[11px] text-danger" title={service.detail ?? undefined}>
                  {service.detail}
                </p>
              )}
            </Tag>
          );
        })}
        {unconfigured.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-xs text-subtle" data-testid="services-not-configured">
            <span>{t("dashboard.servicesNotConfigured", { list: unconfigured.map((s) => SERVICE_META[s.name]!.label).join(", ") })}</span>
            <Link href={CONNECTIONS_HREF} className="inline-flex items-center gap-0.5 font-medium text-muted hover:text-white">
              {t("dashboard.configure")} <ChevronRight size={12} />
            </Link>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** qBittorrent non configuré : la place des téléchargements le dit, sans l'allure d'une panne. */
function TorrentsNotConfigured() {
  const t = useT();
  return (
    <Panel title={t("dashboard.activeDownloads")} icon={Download}>
      <div className="px-4 py-6 text-sm text-subtle">
        <p>{t("dashboard.torrentsNotConfigured")}</p>
        <Link href={CONNECTIONS_HREF} className="mt-2 inline-flex items-center gap-0.5 text-xs font-medium text-muted hover:text-white">
          {t("dashboard.configure")} <ChevronRight size={12} />
        </Link>
      </div>
    </Panel>
  );
}

function DiskSection({ disk, updatedAt, computing }: { disk: DiskStats; updatedAt: number | null; computing: boolean }) {
  const t = useT();
  const other = Math.max(0, disk.disk.used - disk.moviesBytes - disk.tvBytes - disk.seedsBytes);
  const share = (bytes: number) => `${(bytes / disk.disk.total) * 100}%`;
  return (
    <Panel
      title={t('dashboard.storageTitle')}
      icon={HardDrive}
      action={computing ? <RefreshCw size={12} className="animate-spin text-subtle" /> : <StaleIndicator updatedAt={updatedAt} />}
    >
      {disk.mediaMissing || (disk.disk.total <= 0 && !computing) ? (
        // Sans dossier de médias, `df` ne mesurait rien et la carte disait « — libres sur 1.0 B »
        // (installation neuve, 13/10/2026) : un état vide qui dit quoi faire.
        <div className="px-4 py-6 text-sm text-subtle">
          <p>{t('dashboard.storageNoMedia')}</p>
          <Link href={DEPLOYMENT_HREF} className="mt-2 inline-flex items-center gap-0.5 text-xs font-medium text-muted hover:text-white">
            {t('dashboard.storageHowTo')} <ChevronRight size={12} />
          </Link>
        </div>
      ) : disk.disk.total <= 0 ? (
        <p className="px-4 py-6 text-sm text-subtle">{t('dashboard.computingStorage')}</p>
      ) : (
        <div className="p-4">
          <p className="mb-3 text-sm text-muted">{t('dashboard.storageFree', { free: fmtSize(disk.disk.free), total: fmtSize(disk.disk.total) })}</p>
          {/* La légende dessous dit chaque part en clair : la barre n'a pas besoin d'infobulle,
              qu'un doigt n'aurait de toute façon jamais fait apparaître. */}
          <div className="mb-1 flex h-3 w-full overflow-hidden rounded-full bg-white/10" aria-hidden>
            {disk.moviesBytes > 0 && <div className="h-full bg-accent-500" style={{ width: share(disk.moviesBytes) }} />}
            {disk.tvBytes > 0 && <div className="h-full bg-sky-500" style={{ width: share(disk.tvBytes) }} />}
            {disk.seedsBytes > 0 && <div className="h-full bg-amber-500" style={{ width: share(disk.seedsBytes) }} />}
            {other > 0 && <div className="h-full bg-white/30" style={{ width: share(other) }} />}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent-500" />{t('dashboard.storageFilms', { size: fmtSize(disk.moviesBytes) })}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" />{t('dashboard.storageSeries', { size: fmtSize(disk.tvBytes) })}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />{t('dashboard.storageSeeds', { size: fmtSize(disk.seedsBytes) })}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-white/30" />{t('dashboard.storageOther', { size: fmtSize(other) })}</span>
            <span className="ml-auto text-subtle">{t('dashboard.storageUsed', { pct: ((disk.disk.used / disk.disk.total) * 100).toFixed(1) })}</span>
          </div>
          <Link href="/stats" className="mt-3 inline-flex items-center gap-0.5 text-xs text-subtle hover:text-muted">
            {t('nav.stats')} <ChevronRight size={13} />
          </Link>
        </div>
      )}
    </Panel>
  );
}

interface ActivityOverviewPayload {
  accounts: AccountSummary[];
  signals: WeekSignals;
}

function DigestTile({ icon: Icon, label, value, tone = "default" }: { icon: React.ElementType; label: string; value: React.ReactNode; tone?: "default" | "warn" | "bad" }) {
  const toneClass = { default: "text-white", warn: "text-warning", bad: "text-danger" }[tone];
  return (
    <div className="rounded-xl bg-white/4 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Icon size={13} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <span className={`mt-0.5 block text-xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

/**
 * Le résumé de l'Activité du cinéma : les mêmes routes que le panneau (`/api/admin/activity`, la
 * liste des signalements), les mêmes règles (`activityDigest`), relues chaque minute — le panneau,
 * lui, se relit toutes les vingt secondes, mais c'est lui qu'on ouvre pour suivre une séance.
 */
function ActivityDigestSection() {
  const t = useT();
  const { data, error } = useSWR<ActivityOverviewPayload>("/api/admin/activity", fetcher, { refreshInterval: 60_000 });
  const { data: reports } = useSWR<{ reports: ReportSummary[] }>(ADMIN_REPORTS_KEY, fetcher, { refreshInterval: 60_000 });
  const digest = data ? activityDigest(data, reports?.reports ?? null) : null;
  const errorsTotal = digest ? digest.errors.server + digest.errors.client + digest.errors.player : 0;

  return (
    <Panel
      title={t("dashboard.activityDigest.title")}
      icon={Radio}
      action={
        <Link href={ACTIVITY_HREF} className="flex items-center gap-0.5 text-xs text-subtle hover:text-muted">
          {t("dashboard.activityDigest.open")} <ChevronRight size={13} />
        </Link>
      }
    >
      {!digest ? (
        error ? (
          <p className="px-4 py-6 text-sm text-subtle">{t("dashboard.activityDigest.unavailable")}</p>
        ) : (
          <div className="h-32 animate-pulse" />
        )
      ) : (
        <div className="p-3">
          <div className="grid grid-cols-2 gap-2">
            <DigestTile icon={Users} label={t("dashboard.activityDigest.active")} value={digest.active} />
            <DigestTile icon={Clapperboard} label={t("dashboard.activityDigest.playing")} value={digest.playing} />
            <DigestTile
              icon={MessageSquareWarning}
              label={t("dashboard.activityDigest.reports")}
              value={digest.pendingReports ?? "—"}
              tone={digest.pendingReports ? "warn" : "default"}
            />
            <DigestTile icon={ServerCrash} label={t("dashboard.activityDigest.errors")} value={errorsTotal} tone={errorsTotal > 0 ? "bad" : "default"} />
          </div>
          {errorsTotal > 0 && (
            <p className="mt-2 px-1 text-xs text-subtle">
              {t("dashboard.activityDigest.errorsDetail", {
                server: String(digest.errors.server),
                client: String(digest.errors.client),
                player: String(digest.errors.player),
              })}
              {digest.topServerErrors.length > 0 && ` · ${digest.topServerErrors.map((e) => `${e.scope} ×${e.count}`).join(", ")}`}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * Le contrôle de la bibliothèque, en un compteur discret (DECISIONS.md §90) : les désaccords qui
 * demandent un geste (identité, numérotation, fichiers mal rangés), puis l'informatif. La lecture de
 * cette route relance d'elle-même une analyse vieille de plus d'un jour — en arrière-plan.
 */
function LibraryCheckSection() {
  const t = useT();
  const { data } = useSWR<LibraryCheckStatus>("/api/admin/library-check", fetcher, { refreshInterval: (latest) => (latest?.running ? 5_000 : 300_000) });
  const result = data?.result ?? null;
  const actionable = result ? ACTIONABLE_CATEGORIES.reduce((sum, c) => sum + result.counts[c], 0) : 0;
  return (
    <Panel
      title={t("libraryCheck.overview.title")}
      icon={ScanSearch}
      action={
        <Link href="/controle" className="flex items-center gap-0.5 text-xs text-subtle hover:text-muted">
          {t("libraryCheck.overview.open")} <ChevronRight size={13} />
        </Link>
      }
    >
      <div className="px-4 py-4 text-sm" data-testid="library-check-digest">
        {!data ? (
          <div className="h-10 animate-pulse" />
        ) : !result ? (
          <p className="text-subtle">{t(data.running ? "libraryCheck.overview.running" : "libraryCheck.overview.never")}</p>
        ) : (
          <>
            <p className={actionable > 0 ? "font-medium text-warning" : "text-muted"}>
              {actionable > 0 ? t("libraryCheck.overview.count", { n: actionable }) : t("libraryCheck.overview.clean")}
            </p>
            <p className="mt-1 text-xs text-subtle">
              {t("libraryCheck.overview.info", { only: result.counts.jellyfinOnly, links: result.counts.hardlinks })} · <RelativeTime date={result.computedAt} />
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

/** Les derniers imports de Radarr et Sonarr (et les demandes) — le détail est à la page « Imports ». */
function ImportsSection({ items }: { items: ActivityItem[] }) {
  const t = useT();
  return (
    <Panel
      title={t('dashboard.importsTitle')}
      icon={PackageCheck}
      action={
        <Link href="/timeline" className="flex items-center gap-0.5 text-xs text-subtle hover:text-muted">
          {t('dashboard.open')} <ChevronRight size={13} />
        </Link>
      }
    >
      {items.length === 0 ? (
        <EmptyState label={t('dashboard.noImports')} />
      ) : (
        <div className="divide-y divide-white/5">
          {items.map((item) => {
            const Icon = SOURCE_ICON[item.source] ?? Inbox;
            const content = (
              <div className="flex items-center gap-3 px-4 py-2.5">
                <Icon size={15} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">
                    {item.title}{item.detail && <span className="text-subtle"> · {item.detail}</span>}
                  </p>
                  <p className="text-xs text-subtle"><RelativeTime date={item.date} /></p>
                </div>
                <span className="badge shrink-0 text-muted">{ACTIVITY_KINDS.has(item.type) ? t(`activity.${item.type}`) : item.type}</span>
              </div>
            );
            return item.href ? (
              <Link key={item.id} href={item.href} className="block hover:bg-white/4">{content}</Link>
            ) : <div key={item.id}>{content}</div>;
          })}
        </div>
      )}
    </Panel>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardClient({ initialData }: { initialData?: DashboardPayload }) {
  const t = useT();
  const { data, error, isLoading, mutate } = useSWR<DashboardPayload>("/api/dashboard", fetcher, {
    refreshInterval: INTERVALS.FAST,
    fallbackData: initialData,
  });

  return (
    <div>
      <PageHeader title={t('nav.overview')} subtitle={t('dashboard.pageSubtitle')} />

      {isLoading && !data && <SkeletonPanels />}
      {/* Sans données du serveur, un échec laissait une page vide sous le squelette. */}
      {error && !data && <ErrorState message={t('errors.loadFailed')} onRetry={() => mutate()} />}

      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            {/* Téléchargements */}
            {data.torrents.notConfigured ? (
              <TorrentsNotConfigured />
            ) : data.torrents.available && data.torrents.data ? (
              <TorrentsSection torrents={data.torrents.data} />
            ) : (
              <SectionUnavailable label="qBittorrent" error={data.torrents.error} />
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

            {/* L'Activité du cinéma, en résumé */}
            <ActivityDigestSection />

            {/* Le contrôle de la bibliothèque (§90) */}
            <LibraryCheckSection />
          </div>

          {/* Les derniers imports */}
          {data.activity.available && data.activity.data ? (
            <ImportsSection items={data.activity.data} />
          ) : (
            <SectionUnavailable label={t('dashboard.importsTitle')} error={data.activity.error} />
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import useSWR from "swr";
import { useState } from "react";
import { fetcher } from "@/lib/swr";
import { LoadingState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import { INTERVALS } from "@/lib/refresh-intervals";
import { fmtEta, fmtTime, fmtDateTime } from "@/lib/format";
import {
  CircleCheckBig, AlertTriangle, CircleX, RefreshCw,
  PlayCircle, MonitorPlay, KeyRound, Film, Tv, Captions, Search, Send, Download,
  CirclePlus, Compass, ChevronDown, History,
  CalendarDays, Sparkles, BarChart3, Radio, RotateCcw, Star, UserRound, Globe, Bell,
  FileSearch, ListChecks, Clapperboard, Layers, Shuffle, CalendarRange, DownloadCloud,
  ListOrdered, Radar, GalleryHorizontal,
} from "lucide-react";

// Shared between the in-app admin/user health page (src/app/(dashboard)/health/page.tsx) and
// the standalone public status page (src/app/status/page.tsx, reachable without logging in) —
// same "what can I actually do right now" view either way.

export type CapStatus = "ok" | "degraded" | "down";

interface CapabilityDep {
  service: string;
  status: CapStatus;
}

interface CapabilityIncident {
  type: "maintenance" | "incident" | "ongoing";
  start: number;
  end: number | null;
  durationMs: number | null;
}

interface CapabilityResult {
  id: string;
  status: CapStatus;
  note: string | null;
  dependsOn: CapabilityDep[];
  softDependsOn: CapabilityDep[];
  uptime7d: number;
  incidents7d: CapabilityIncident[];
}

interface PublicStatusResponse {
  overall: CapStatus;
  checkedAt: string;
  capabilities: CapabilityResult[];
}

export const OVERALL_STYLE = {
  ok:       "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  degraded: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  down:     "text-red-400 bg-red-500/10 border-red-500/20",
};

export function StatusIcon({ status }: { status: CapStatus }) {
  if (status === "ok")       return <CircleCheckBig size={16} className="text-emerald-400" />;
  if (status === "degraded") return <AlertTriangle size={16} className="text-amber-400" />;
  return                            <CircleX size={16} className="text-red-400" />;
}

const CAPABILITY_ICONS: Record<string, React.ElementType> = {
  watchJellyfin: PlayCircle,
  watchCineApp: MonitorPlay,
  auth: KeyRound,
  movieLibrary: Film,
  seriesLibrary: Tv,
  subtitles: Captions,
  searchEngine: Search,
  requestMedia: Send,
  download: Download,
  addMovies: CirclePlus,
  addSeries: CirclePlus,
  discovery: Compass,
  calendar: CalendarDays,
  recommendations: Sparkles,
  libraryStats: BarChart3,
  liveSessions: Radio,
  resumePlayback: RotateCcw,
  multiSourceRatings: Star,
  actorPages: UserRound,
  globalSearch: Globe,
  pushNotifications: Bell,
  manualSubtitleSearch: FileSearch,
  watchlist: ListChecks,
  trailers: Clapperboard,
  collections: Layers,
  similarMedia: Shuffle,
  externalReleaseDates: CalendarRange,
  activeDownloads: DownloadCloud,
  importQueue: ListOrdered,
  indexerStatus: Radar,
  videoPreviews: GalleryHorizontal,
};

const CAP_DOT = {
  ok: "bg-emerald-400",
  degraded: "bg-amber-400",
  down: "bg-red-400",
};

// Purely a display grouping — every id here still comes from the same flat capability list the
// API returns; a capability that's missing from every group here (shouldn't happen, but new ids
// added to healthChecks.ts without a home here) falls back into an "other" bucket instead of
// silently disappearing.
const CATEGORIES: { id: string; capabilityIds: string[] }[] = [
  { id: "playback", capabilityIds: ["watchJellyfin", "watchCineApp", "resumePlayback", "liveSessions", "videoPreviews"] },
  { id: "account", capabilityIds: ["auth", "pushNotifications"] },
  { id: "discover", capabilityIds: ["discovery", "recommendations", "trailers", "collections", "similarMedia", "externalReleaseDates", "actorPages", "multiSourceRatings", "globalSearch", "calendar"] },
  { id: "myList", capabilityIds: ["watchlist", "addMovies", "addSeries", "requestMedia"] },
  { id: "downloads", capabilityIds: ["download", "activeDownloads", "importQueue", "indexerStatus", "searchEngine"] },
  { id: "library", capabilityIds: ["movieLibrary", "seriesLibrary", "libraryStats", "subtitles", "manualSubtitleSearch"] },
];

function CapabilityCard({ cap }: { cap: CapabilityResult }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const Icon = CAPABILITY_ICONS[cap.id] ?? Film;

  return (
    <div className="card p-2.5">
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          <Icon size={14} className="shrink-0 text-slate-400" />
          <p className="text-xs font-medium text-white">{t(`health.capabilities.${cap.id}`)}</p>
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full ${CAP_DOT[cap.status]}`} />
      </div>

      {cap.note && (
        <p className="mt-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-400">
          {t(`health.degradedNote.${cap.note}`)}
        </p>
      )}

      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 flex w-full items-center justify-between rounded-md px-0.5 py-0.5 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
      >
        <span className="flex items-center gap-1">
          <History size={10} />
          {t('health.history.uptime', { pct: String(cap.uptime7d) })}
        </span>
        <ChevronDown size={12} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1 border-t border-white/5 pt-1.5">
          {cap.incidents7d.length === 0 && (
            <p className="text-[10px] text-slate-600">{t('health.history.noIncidents')}</p>
          )}
          {cap.incidents7d.map((inc, i) => {
            const startTime = fmtDateTime(inc.start);
            const endTime = inc.end ? fmtTime(inc.end) : null;
            const duration = inc.durationMs ? fmtEta(Math.round(inc.durationMs / 1000)) : null;
            if (inc.type === "maintenance") {
              return (
                <p key={i} className="text-[10px] text-slate-500">
                  {t('health.history.maintenance', { time: startTime })}
                </p>
              );
            }
            if (inc.type === "ongoing") {
              return (
                <p key={i} className="text-[10px] text-red-400">
                  {t('health.history.ongoing', { start: startTime })}
                </p>
              );
            }
            return (
              <p key={i} className="text-[10px] text-amber-400">
                {t('health.history.incident', { start: startTime, end: endTime ?? "", duration: duration ?? "" })}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CapabilitySection() {
  const t = useT();
  const { data, isLoading, mutate, isValidating } = useSWR<PublicStatusResponse>(
    "/api/status/public",
    fetcher,
    { refreshInterval: INTERVALS.FAST }
  );

  const overall = data?.overall ?? "ok";
  const capabilities = data?.capabilities ?? [];
  const checkedAt = data?.checkedAt ? fmtTime(data.checkedAt) : null;

  const OVERALL_LABEL = {
    ok: t('health.overall.ok'),
    degraded: t('health.overall.degraded'),
    down: t('health.overall.down'),
  };

  return (
    <div>
      <h2 className="mb-4 text-base font-semibold text-white">{t('health.capabilitiesTitle')}</h2>

      {isLoading && <LoadingState label={t('health.checking')} />}

      {!isLoading && (
        <>
          <div className={`mb-4 flex items-center justify-between rounded-xl border px-4 py-3 ${OVERALL_STYLE[overall]}`}>
            <div className="flex items-center gap-2">
              <StatusIcon status={overall} />
              <span className="text-sm font-medium">{OVERALL_LABEL[overall]}</span>
            </div>
            <div className="flex items-center gap-3">
              {checkedAt && <span className="text-[11px] opacity-60">{t('health.updatedAt', { time: checkedAt })}</span>}
              <button
                onClick={() => mutate()}
                disabled={isValidating}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs border border-current/20 opacity-70 hover:opacity-100 transition-opacity disabled:opacity-40"
              >
                <RefreshCw size={11} className={isValidating ? "animate-spin" : ""} />
                {t('common.refresh')}
              </button>
            </div>
          </div>

          {(() => {
            const byId = new Map(capabilities.map((c) => [c.id, c]));
            const categorized = new Set(CATEGORIES.flatMap((c) => c.capabilityIds));
            const other = capabilities.filter((c) => !categorized.has(c.id));
            const sections = [
              ...CATEGORIES.map((cat) => ({ id: cat.id, caps: cat.capabilityIds.map((id) => byId.get(id)).filter((c): c is CapabilityResult => !!c) })),
              ...(other.length > 0 ? [{ id: "other", caps: other }] : []),
            ].filter((s) => s.caps.length > 0);

            return (
              <div className="space-y-6">
                {sections.map((section) => (
                  <div key={section.id}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {t(`health.categories.${section.id}`)}
                    </h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
                      {section.caps.map((cap) => <CapabilityCard key={cap.id} cap={cap} />)}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

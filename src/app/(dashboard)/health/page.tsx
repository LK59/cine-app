"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/StateViews";
import type { ServiceHealth } from "@/app/api/health/route";
import { CircleCheckBig, CircleX, RefreshCw, Loader2, Wrench } from "lucide-react";
import { INTERVALS } from "@/lib/refresh-intervals";
import { useState, useCallback } from "react";
import { useT } from "@/components/TranslationProvider";
import { useRole } from "@/lib/useRole";
import { fmtTime } from "@/lib/format";
import { CapabilitySection, StatusIcon, OVERALL_STYLE } from "@/components/CapabilityStatus";

interface HealthResponse {
  overall: "ok" | "degraded" | "down";
  checkedAt: string;
  services: ServiceHealth[];
}

function LatencyBar({ ms }: { ms: number | null }) {
  if (ms === null) return <span className="text-slate-600 text-xs">—</span>;
  // Bar width is purely informational (capped at 3 s) — color reflects success, not speed
  const width = Math.min(100, (ms / 3000) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-slate-800">
        <div className="h-full rounded-full bg-slate-500" style={{ width: `${width}%` }} />
      </div>
      <span className="text-[11px] text-slate-400">{ms} ms</span>
    </div>
  );
}

// ─── API endpoint health checks ───────────────────────────────────────────────

interface ApiEndpointDef {
  name: string;
  route: string;
  group: string;
  validate?: (json: unknown) => boolean;
}

interface ApiEndpointResult extends ApiEndpointDef {
  status: "ok" | "error" | "pending";
  latencyMs: number | null;
  statusCode: number | null;
  error?: string;
}

const API_ENDPOINTS: ApiEndpointDef[] = [
  { group: "health.groups.dashboard",   name: "health.endpoints.dashboard",       route: "/api/dashboard",             validate: (j) => typeof j === "object" && j !== null },
  { group: "health.groups.radarr",      name: "health.endpoints.metadata",        route: "/api/radarr/meta",            validate: (j) => Array.isArray((j as Record<string, unknown>)?.qualityProfiles) },
  { group: "health.groups.radarr",      name: "health.endpoints.calendar",        route: "/api/radarr/calendar",        validate: Array.isArray },
  { group: "health.groups.radarr",      name: "health.endpoints.queue",           route: "/api/radarr/queue",           validate: (j) => Array.isArray((j as Record<string, unknown>)?.records) },
  { group: "health.groups.sonarr",      name: "health.endpoints.metadata",        route: "/api/sonarr/meta",            validate: (j) => Array.isArray((j as Record<string, unknown>)?.qualityProfiles) },
  { group: "health.groups.sonarr",      name: "health.endpoints.calendar",        route: "/api/sonarr/calendar",        validate: Array.isArray },
  { group: "health.groups.sonarr",      name: "health.endpoints.queue",           route: "/api/sonarr/queue",           validate: (j) => Array.isArray((j as Record<string, unknown>)?.records) },
  { group: "health.groups.jellyfin",    name: "health.endpoints.library",         route: "/api/jellyfin/library",       validate: (j) => typeof (j as Record<string, unknown>)?.counts === "object" },
  { group: "health.groups.jellyfin",    name: "health.endpoints.resumeItems",     route: "/api/jellyfin/resume",        validate: (j) => Array.isArray((j as Record<string, unknown>)?.items) },
  { group: "health.groups.jellyfin",    name: "health.endpoints.activeSessions",  route: "/api/jellyfin/sessions",      validate: Array.isArray },
  { group: "health.groups.jellyseerr",  name: "health.endpoints.myRequests",      route: "/api/jellyseerr/my-requests", validate: (j) => Array.isArray((j as Record<string, unknown>)?.results) },
  { group: "health.groups.qbittorrent", name: "health.endpoints.torrents",        route: "/api/qbittorrent/torrents",   validate: Array.isArray },
  { group: "health.groups.qbittorrent", name: "health.endpoints.transfer",        route: "/api/qbittorrent/transfer",   validate: (j) => typeof j === "object" && j !== null },
  { group: "health.groups.bazarr",      name: "health.endpoints.missingSubtitles",route: "/api/bazarr/wanted",          validate: (j) => typeof (j as Record<string, unknown>)?.movies === "object" },
  { group: "health.groups.jackett",     name: "health.endpoints.indexers",        route: "/api/jackett/indexers",       validate: Array.isArray },
  { group: "health.groups.tmdb",        name: "health.endpoints.trendingMovies",  route: "/api/discover/movies",        validate: (j) => Array.isArray((j as Record<string, unknown>)?.items) },
  { group: "health.groups.multiSource", name: "health.endpoints.aggregatedCalendar", route: "/api/calendar",            validate: (j) => Array.isArray((j as Record<string, unknown>)?.events) },
  { group: "health.groups.multiSource", name: "health.endpoints.recentActivity",  route: "/api/activity",               validate: Array.isArray },
  { group: "health.groups.system",      name: "health.endpoints.diskStats",       route: "/api/stats",                  validate: (j) => typeof (j as Record<string, unknown>)?.disk === "object" },
];

async function runApiCheck(ep: ApiEndpointDef): Promise<ApiEndpointResult> {
  const start = Date.now();
  try {
    const res = await fetch(ep.route, { signal: AbortSignal.timeout(8000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ...ep, status: "error", latencyMs, statusCode: res.status, error: `HTTP ${res.status}` };
    }
    let json: unknown;
    try { json = await res.json(); } catch { json = null; }
    const valid = ep.validate ? ep.validate(json) : true;
    return {
      ...ep,
      status: valid ? "ok" : "error",
      latencyMs,
      statusCode: res.status,
      error: valid ? undefined : "unexpectedResponse",
    };
  } catch (e) {
    return {
      ...ep,
      status: "error",
      latencyMs: Date.now() - start,
      statusCode: null,
      error: e instanceof Error ? e.message : "Timeout",
    };
  }
}

function ApiStatusBadge({ status }: { status: ApiEndpointResult["status"] }) {
  if (status === "pending") return <Loader2 size={14} className="animate-spin text-slate-500" />;
  if (status === "ok")      return <CircleCheckBig size={14} className="text-emerald-400" />;
  return                           <CircleX size={14} className="text-red-400" />;
}

function ApiChecksSection() {
  const t = useT();
  const [results, setResults] = useState<ApiEndpointResult[]>([]);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    // Show pending state immediately
    setResults(API_ENDPOINTS.map((ep) => ({ ...ep, status: "pending", latencyMs: null, statusCode: null })));
    const settled = await Promise.allSettled(API_ENDPOINTS.map(runApiCheck));
    setResults(settled.map((r) => r.status === "fulfilled" ? r.value : { ...API_ENDPOINTS[0], status: "error", latencyMs: null, statusCode: null, error: "internalError" }));
    setRanAt(fmtTime(new Date()));
    setRunning(false);
  }, []);

  // Group results by group name
  const groups = API_ENDPOINTS.reduce<string[]>((acc, ep) => acc.includes(ep.group) ? acc : [...acc, ep.group], []);

  const okCount  = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">{t('health.apiTests.sectionTitle')}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{t('health.apiTests.sectionSubtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {ranAt && results.length > 0 && !running && (
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span className="text-emerald-400">{t('health.apiTests.ok', { n: String(okCount) })}</span>
              {errCount > 0 && <span className="text-red-400">{t('health.apiTests.errors', { n: String(errCount) })}</span>}
              <span>· {ranAt}</span>
            </div>
          )}
          <button
            onClick={run}
            disabled={running}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={12} className={running ? "animate-spin" : ""} />
            {running ? t('health.apiTests.running') : results.length === 0 ? t('health.apiTests.run') : t('health.apiTests.rerun')}
          </button>
        </div>
      </div>

      {results.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
          {t('health.apiTests.empty')}
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-4">
          {groups.map((group) => {
            const groupResults = results.filter((r) => r.group === group);
            const allOk  = groupResults.every((r) => r.status === "ok");
            const anyErr = groupResults.some((r) => r.status === "error");
            const groupStatus = allOk ? "ok" : anyErr ? "error" : "pending";
            return (
              <div key={group} className="card overflow-hidden">
                <div className={`flex items-center gap-2 border-b border-white/5 px-4 py-2.5 ${
                  groupStatus === "ok" ? "bg-emerald-500/5" : groupStatus === "error" ? "bg-red-500/5" : "bg-slate-800/30"
                }`}>
                  {groupStatus === "pending" && <Loader2 size={13} className="animate-spin text-slate-500" />}
                  {groupStatus === "ok"      && <CircleCheckBig size={13} className="text-emerald-400" />}
                  {groupStatus === "error"   && <CircleX size={13} className="text-red-400" />}
                  <span className="text-sm font-semibold text-white">{t(group)}</span>
                </div>
                <div className="divide-y divide-white/5">
                  {groupResults.map((r) => (
                    <div key={r.route} className="flex items-center gap-3 px-4 py-2.5">
                      <ApiStatusBadge status={r.status} />
                      <div className="min-w-0 flex-1">
                        <span className="text-sm text-slate-200">{t(r.name)}</span>
                        <span className="ml-2 font-mono text-[10px] text-slate-600">{r.route}</span>
                      </div>
                      <div className="shrink-0 text-right">
                        {r.status === "error" && r.error && (
                          <span className="mr-3 text-[11px] text-red-400">
                            {r.error === "unexpectedResponse" ? t('health.apiTests.unexpectedResponse')
                              : r.error === "internalError" ? t('health.apiTests.internalError')
                              : r.error}
                          </span>
                        )}
                        {r.latencyMs !== null && (
                          <LatencyBar ms={r.latencyMs} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Technical detail (admin only) ─────────────────────────────────────────────

function TechnicalDetail() {
  const t = useT();
  const { data, isLoading, mutate, isValidating } = useSWR<HealthResponse>(
    "/api/health",
    fetcher,
    { refreshInterval: INTERVALS.FAST }
  );

  const overall = data?.overall ?? "ok";
  const services = data?.services ?? [];
  const checkedAt = data?.checkedAt ? fmtTime(data.checkedAt) : null;

  const OVERALL_LABEL = {
    ok:       t('health.overall.ok'),
    degraded: t('health.overall.degraded'),
    down:     t('health.overall.down'),
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Wrench size={16} className="text-slate-500" />
        <h2 className="text-base font-semibold text-white">{t('health.technicalTitle')}</h2>
      </div>

      {isLoading && <LoadingState label={t('health.checking')} />}

      {!isLoading && (
        <>
          {/* Overall status banner */}
          <div className={`mb-6 flex items-center justify-between rounded-xl border px-4 py-3 ${OVERALL_STYLE[overall]}`}>
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

          {/* Services grid */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((svc) => (
              <div key={svc.name} className="card p-4">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-white">{svc.name}</p>
                    <p className="truncate text-[11px] text-slate-500">{svc.url}</p>
                  </div>
                  <StatusIcon status={svc.status} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">{t('health.latency')}</span>
                    <LatencyBar ms={svc.latencyMs} />
                  </div>
                  {svc.version && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">{t('health.version')}</span>
                      <span className="text-xs text-slate-300 font-mono">{svc.version}</span>
                    </div>
                  )}
                  {svc.error && (
                    <div className="mt-1 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
                      {svc.error}
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">{t('health.status')}</span>
                    <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                      svc.status === "ok"       ? "bg-emerald-500/15 text-emerald-400"
                      : svc.status === "degraded" ? "bg-amber-500/15 text-amber-400"
                      : "bg-red-500/15 text-red-400"
                    }`}>
                      {svc.status === "ok" ? t('health.statusOnline') : svc.status === "degraded" ? t('health.statusDegraded') : t('health.statusOffline')}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* API routes section */}
          <ApiChecksSection />
        </>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function HealthPage() {
  const t = useT();
  const { role } = useRole();

  return (
    <div>
      <PageHeader
        title={t('health.pageTitle')}
        subtitle={t('health.subtitle')}
      />

      <CapabilitySection />

      {role === "admin" && (
        <div className="mt-10 border-t border-white/5 pt-8">
          <TechnicalDetail />
        </div>
      )}
    </div>
  );
}

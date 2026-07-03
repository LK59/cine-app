"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/StateViews";
import type { ServiceHealth } from "@/app/api/health/route";
import { CheckCircle, AlertTriangle, XCircle, RefreshCw, Loader2 } from "lucide-react";
import { INTERVALS } from "@/lib/refresh-intervals";
import { useState, useCallback } from "react";

interface HealthResponse {
  overall: "ok" | "degraded" | "down";
  checkedAt: string;
  services: ServiceHealth[];
}

function StatusIcon({ status }: { status: ServiceHealth["status"] }) {
  if (status === "ok")       return <CheckCircle   size={16} className="text-emerald-400" />;
  if (status === "degraded") return <AlertTriangle size={16} className="text-amber-400" />;
  return                            <XCircle       size={16} className="text-red-400" />;
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

const OVERALL_STYLE = {
  ok:       "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  degraded: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  down:     "text-red-400 bg-red-500/10 border-red-500/20",
};
const OVERALL_LABEL = {
  ok:       "Tous les services sont opérationnels",
  degraded: "Dégradé — certains services ont des problèmes",
  down:     "Critique — des services sont hors ligne",
};

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
  { group: "Dashboard", name: "Agrégat dashboard",    route: "/api/dashboard",             validate: (j) => typeof j === "object" && j !== null },
  { group: "Radarr",      name: "Métadonnées",           route: "/api/radarr/meta",            validate: (j) => Array.isArray((j as Record<string, unknown>)?.qualityProfiles) },
  { group: "Radarr",      name: "Calendrier",            route: "/api/radarr/calendar",        validate: Array.isArray },
  { group: "Radarr",      name: "File d'attente",        route: "/api/radarr/queue",           validate: (j) => Array.isArray((j as Record<string, unknown>)?.records) },
  { group: "Sonarr",      name: "Métadonnées",           route: "/api/sonarr/meta",            validate: (j) => Array.isArray((j as Record<string, unknown>)?.qualityProfiles) },
  { group: "Sonarr",      name: "Calendrier",            route: "/api/sonarr/calendar",        validate: Array.isArray },
  { group: "Sonarr",      name: "File d'attente",        route: "/api/sonarr/queue",           validate: (j) => Array.isArray((j as Record<string, unknown>)?.records) },
  { group: "Jellyfin",    name: "Bibliothèque",          route: "/api/jellyfin/library",       validate: (j) => typeof (j as Record<string, unknown>)?.counts === "object" },
  { group: "Jellyfin",    name: "Reprises en cours",     route: "/api/jellyfin/resume",        validate: (j) => Array.isArray((j as Record<string, unknown>)?.items) },
  { group: "Jellyfin",    name: "Sessions actives",      route: "/api/jellyfin/sessions",      validate: Array.isArray },
  { group: "Jellyseerr",  name: "Mes demandes",          route: "/api/jellyseerr/my-requests", validate: (j) => Array.isArray((j as Record<string, unknown>)?.results) },
  { group: "qBittorrent", name: "Torrents",              route: "/api/qbittorrent/torrents",   validate: Array.isArray },
  { group: "qBittorrent", name: "Transfert",             route: "/api/qbittorrent/transfer",   validate: (j) => typeof j === "object" && j !== null },
  { group: "Bazarr",      name: "Sous-titres manquants", route: "/api/bazarr/wanted",          validate: (j) => typeof (j as Record<string, unknown>)?.movies === "object" },
  { group: "Jackett",     name: "Indexeurs",             route: "/api/jackett/indexers",       validate: Array.isArray },
  { group: "TMDB",        name: "Films tendance",        route: "/api/discover/movies",        validate: (j) => Array.isArray((j as Record<string, unknown>)?.items) },
  { group: "Multi-source",name: "Calendrier agrégé",     route: "/api/calendar",               validate: (j) => Array.isArray((j as Record<string, unknown>)?.events) },
  { group: "Multi-source",name: "Activité récente",      route: "/api/activity",               validate: Array.isArray },
  { group: "Système",     name: "Stats disque",          route: "/api/stats",                  validate: (j) => typeof (j as Record<string, unknown>)?.disk === "object" },
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
      error: valid ? undefined : "Réponse inattendue",
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
  if (status === "ok")      return <CheckCircle size={14} className="text-emerald-400" />;
  return                           <XCircle size={14} className="text-red-400" />;
}

function ApiChecksSection() {
  const [results, setResults] = useState<ApiEndpointResult[]>([]);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    // Show pending state immediately
    setResults(API_ENDPOINTS.map((ep) => ({ ...ep, status: "pending", latencyMs: null, statusCode: null })));
    const settled = await Promise.allSettled(API_ENDPOINTS.map(runApiCheck));
    setResults(settled.map((r) => r.status === "fulfilled" ? r.value : { ...API_ENDPOINTS[0], status: "error", latencyMs: null, statusCode: null, error: "Erreur interne" }));
    setRanAt(new Date().toLocaleTimeString("fr-FR"));
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
          <h2 className="text-base font-semibold text-white">Tests des routes API</h2>
          <p className="text-xs text-slate-500 mt-0.5">Vérifie chaque endpoint interne — authentification, latence et forme de réponse</p>
        </div>
        <div className="flex items-center gap-3">
          {ranAt && results.length > 0 && !running && (
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span className="text-emerald-400">{okCount} ok</span>
              {errCount > 0 && <span className="text-red-400">{errCount} erreur{errCount > 1 ? "s" : ""}</span>}
              <span>· {ranAt}</span>
            </div>
          )}
          <button
            onClick={run}
            disabled={running}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={12} className={running ? "animate-spin" : ""} />
            {running ? "Test en cours…" : results.length === 0 ? "Lancer les tests" : "Relancer"}
          </button>
        </div>
      </div>

      {results.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
          Cliquez sur « Lancer les tests » pour vérifier toutes les routes API
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
                  {groupStatus === "ok"      && <CheckCircle size={13} className="text-emerald-400" />}
                  {groupStatus === "error"   && <XCircle size={13} className="text-red-400" />}
                  <span className="text-sm font-semibold text-white">{group}</span>
                </div>
                <div className="divide-y divide-white/5">
                  {groupResults.map((r) => (
                    <div key={r.route} className="flex items-center gap-3 px-4 py-2.5">
                      <ApiStatusBadge status={r.status} />
                      <div className="min-w-0 flex-1">
                        <span className="text-sm text-slate-200">{r.name}</span>
                        <span className="ml-2 font-mono text-[10px] text-slate-600">{r.route}</span>
                      </div>
                      <div className="shrink-0 text-right">
                        {r.status === "error" && r.error && (
                          <span className="mr-3 text-[11px] text-red-400">{r.error}</span>
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

// ─── PWA update section ───────────────────────────────────────────────────────

function PwaSection() {
  const [status, setStatus] = useState<"idle" | "checking" | "updated" | "latest">("idle");

  const update = useCallback(async () => {
    if (!("serviceWorker" in navigator)) return;
    setStatus("checking");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { setStatus("idle"); return; }
      await reg.update();
      if (reg.waiting) {
        reg.waiting.postMessage({ type: "SKIP_WAITING" });
        setTimeout(() => window.location.reload(), 300);
        setStatus("updated");
      } else {
        setStatus("latest");
        setTimeout(() => setStatus("idle"), 3000);
      }
    } catch { setStatus("idle"); }
  }, []);

  return (
    <div className="mt-8">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-white">Application</h2>
        <p className="text-xs text-slate-500 mt-0.5">Mise à jour de la PWA sans réinstallation</p>
      </div>
      <div className="card p-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-white">Mettre à jour la PWA</p>
          <p className="text-xs text-slate-500 mt-0.5">Vérifie et installe la dernière version du Service Worker</p>
        </div>
        <div className="flex items-center gap-3">
          {status === "latest" && <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle size={13} /> Déjà à jour</span>}
          {status === "updated" && <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle size={13} /> Mise à jour appliquée</span>}
          <button
            onClick={update}
            disabled={status === "checking"}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-60"
          >
            <RefreshCw size={13} className={status === "checking" ? "animate-spin" : ""} />
            {status === "checking" ? "Vérification…" : "Mettre à jour"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function HealthPage() {
  const { data, isLoading, mutate, isValidating } = useSWR<HealthResponse>(
    "/api/health",
    fetcher,
    { refreshInterval: INTERVALS.FAST }
  );

  const overall = data?.overall ?? "ok";
  const services = data?.services ?? [];
  const checkedAt = data?.checkedAt ? new Date(data.checkedAt).toLocaleTimeString("fr-FR") : null;

  return (
    <div>
      <PageHeader
        title="Santé système"
        subtitle="État en temps réel de tous les services"
      />

      {isLoading && <LoadingState label="Vérification des services…" />}

      {!isLoading && (
        <>
          {/* Overall status banner */}
          <div className={`mb-6 flex items-center justify-between rounded-xl border px-4 py-3 ${OVERALL_STYLE[overall]}`}>
            <div className="flex items-center gap-2">
              <StatusIcon status={overall} />
              <span className="text-sm font-medium">{OVERALL_LABEL[overall]}</span>
            </div>
            <div className="flex items-center gap-3">
              {checkedAt && <span className="text-[11px] opacity-60">Mis à jour à {checkedAt}</span>}
              <button
                onClick={() => mutate()}
                disabled={isValidating}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs border border-current/20 opacity-70 hover:opacity-100 transition-opacity disabled:opacity-40"
              >
                <RefreshCw size={11} className={isValidating ? "animate-spin" : ""} />
                Actualiser
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
                    <span className="text-xs text-slate-500">Latence</span>
                    <LatencyBar ms={svc.latencyMs} />
                  </div>
                  {svc.version && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Version</span>
                      <span className="text-xs text-slate-300 font-mono">{svc.version}</span>
                    </div>
                  )}
                  {svc.error && (
                    <div className="mt-1 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
                      {svc.error}
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Statut</span>
                    <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                      svc.status === "ok"       ? "bg-emerald-500/15 text-emerald-400"
                      : svc.status === "degraded" ? "bg-amber-500/15 text-amber-400"
                      : "bg-red-500/15 text-red-400"
                    }`}>
                      {svc.status === "ok" ? "En ligne" : svc.status === "degraded" ? "Dégradé" : "Hors ligne"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* API routes section */}
          <ApiChecksSection />

          {/* PWA update */}
          <PwaSection />

        </>
      )}
    </div>
  );
}

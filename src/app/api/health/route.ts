import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export interface ServiceHealth {
  name: string;
  url: string;
  status: "ok" | "degraded" | "down";
  latencyMs: number | null;
  version: string | null;
  error: string | null;
}

// Generic ping for services with X-Api-Key header
async function pingWithKey(
  name: string,
  baseUrl: string,
  path: string,
  apiKey: string,
  versionKeys?: string[],
): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name, url: baseUrl, status: "degraded", latencyMs, version: null, error: `HTTP ${res.status}` };
    let version: string | null = null;
    try {
      const json = await res.json();
      if (versionKeys) version = versionKeys.reduce((o: any, k) => o?.[k], json) ?? null;
    } catch {}
    return { name, url: baseUrl, status: "ok", latencyMs, version, error: null };
  } catch (e: any) {
    return { name, url: baseUrl, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

// Jellyfin — public endpoint, no key needed
async function pingJellyfin(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${config.jellyfin.url}/System/Info/Public`, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name: "Jellyfin", url: config.jellyfin.url, status: "degraded", latencyMs, version: null, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { name: "Jellyfin", url: config.jellyfin.url, status: "ok", latencyMs, version: json.Version ?? null, error: null };
  } catch (e: any) {
    return { name: "Jellyfin", url: config.jellyfin.url, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

// Jellyseerr — no API key on /api/v1/status
async function pingJellyseerr(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${config.jellyseerr.url}/api/v1/status`, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name: "Jellyseerr", url: config.jellyseerr.url, status: "degraded", latencyMs, version: null, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { name: "Jellyseerr", url: config.jellyseerr.url, status: "ok", latencyMs, version: json.version ?? null, error: null };
  } catch (e: any) {
    return { name: "Jellyseerr", url: config.jellyseerr.url, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

// Simple reachability ping — any HTTP response = service is up
async function pingReachable(name: string, url: string, path = "/"): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    });
    const latencyMs = Date.now() - start;
    // Any response (including 4xx) means the service is up and reachable
    return { name, url, status: "ok", latencyMs, version: null, error: null };
  } catch (e: any) {
    return { name, url, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

export async function GET() {
  const checks = await Promise.all([
    pingJellyfin(),
    pingWithKey("Radarr",   config.radarr.url,   "/api/v3/system/status", config.radarr.apiKey,   ["version"]),
    pingWithKey("Sonarr",   config.sonarr.url,   "/api/v3/system/status", config.sonarr.apiKey,   ["version"]),
    pingJellyseerr(),
    pingWithKey("Bazarr",   config.bazarr.url,   "/api/badges/episodes",  config.bazarr.apiKey),
    pingReachable("Jackett",     config.jackett.url,     "/UI/Dashboard"),
    pingReachable("qBittorrent", config.qbittorrent.url, "/"),
  ]);

  const allOk    = checks.every((c) => c.status === "ok");
  const anyDown  = checks.some((c)  => c.status === "down");

  return NextResponse.json({
    overall: allOk ? "ok" : anyDown ? "down" : "degraded",
    checkedAt: new Date().toISOString(),
    services: checks,
  });
}

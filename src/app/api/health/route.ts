import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { pingJellyfin, pingJellyseerr, pingReachable, pingWithKey, type ServiceHealth } from "@/lib/healthChecks";

export const dynamic = "force-dynamic";

export type { ServiceHealth };

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

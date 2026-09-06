import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { statusHistoryDb, type ServiceLatencyStat } from "@/lib/db";
import { pingJellyfin, pingJellyseerr, pingReachable, pingWithKey, checkAllStoragePaths, type ServiceHealth, type StoragePathHealth } from "@/lib/healthChecks";

export const dynamic = "force-dynamic";

const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

export type { ServiceHealth, StoragePathHealth, ServiceLatencyStat };

export async function GET() {
  const [checks, paths] = await Promise.all([
    Promise.all([
      pingJellyfin(),
      pingWithKey("Radarr",   config.radarr.url,   "/api/v3/system/status", config.radarr.apiKey,   ["version"]),
      pingWithKey("Sonarr",   config.sonarr.url,   "/api/v3/system/status", config.sonarr.apiKey,   ["version"]),
      pingJellyseerr(),
      pingWithKey("Bazarr",   config.bazarr.url,   "/api/badges/episodes",  config.bazarr.apiKey),
      pingReachable("Jackett",     config.jackett.url,     "/UI/Dashboard"),
      pingReachable("qBittorrent", config.qbittorrent.url, "/"),
    ]),
    checkAllStoragePaths(),
  ]);

  const allOk    = checks.every((c) => c.status === "ok") && paths.every((p) => p.status === "ok");
  const anyDown  = checks.some((c)  => c.status === "down") || paths.some((p) => p.status === "down");

  return NextResponse.json({
    overall: allOk ? "ok" : anyDown ? "down" : "degraded",
    checkedAt: new Date().toISOString(),
    services: checks,
    paths,
    /**
     * Ce que les relevés de la dernière semaine disent, par-delà l'instant présent.
     *
     * Les mesures ci-dessus datent de cette seconde : elles disent si un service répond, jamais
     * s'il répond moins bien qu'avant. La sonde tourne pourtant chaque minute et garde tout —
     * sans que personne ne l'ait jamais lu. C'est la même donnée, enfin regardée.
     */
    latencyHistory: statusHistoryDb.getServiceLatencyStats(Date.now() - SEVEN_DAYS_MS),
  });
}

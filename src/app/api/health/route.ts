import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { statusHistoryDb, type ServiceLatencyStat } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { pingJellyfin, pingJellyseerr, pingReachable, pingWithKey, checkAllStoragePaths, type ServiceHealth, type StoragePathHealth } from "@/lib/healthChecks";

export const dynamic = "force-dynamic";

const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

export type { ServiceHealth, StoragePathHealth, ServiceLatencyStat };

/**
 * Ce qu'un compte non admin voit d'un relevé : l'état et la latence, pas l'intérieur.
 *
 * La route répondait la même chose à tout compte connecté : l'adresse interne de chaque service
 * (`http://radarr:7878`…), les chemins montés dans le conteneur, et le message brut de l'erreur
 * (`getaddrinfo ENOTFOUND …`, `EACCES: permission denied, scandir '/mnt/…'`) — une carte du
 * réseau et du disque pour qui n'a rien à y faire (26/09/2026). L'admin garde tout : c'est sa
 * page d'état. Les champs restent présents, vides, pour que la page les affiche sans broncher.
 */
function forNonAdmin(services: ServiceHealth[], paths: StoragePathHealth[]) {
  return {
    services: services.map((s) => ({
      ...s,
      url: "",
      // Un statut HTTP ne dit rien de l'intérieur ; un message d'exception, si.
      // (le badge d'état dit déjà « hors service » ; la page n'affiche le message que s'il existe).
      error: s.error && /^HTTP \d{3}$/.test(s.error) ? s.error : null,
    })),
    paths: paths.map((p) => ({
      ...p,
      path: "",
      // Les deux codes que la page traduit ; tout le reste était un message système brut.
      error: p.error === "notFound" ? "notFound" : p.error ? "notReadable" : null,
    })),
  };
}

export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
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

  const shown = session?.role === "admin" ? { services: checks, paths } : forNonAdmin(checks, paths);

  return NextResponse.json({
    overall: allOk ? "ok" : anyDown ? "down" : "degraded",
    checkedAt: new Date().toISOString(),
    ...shown,
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

import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { withCache, TTL } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface TimelineEntry {
  id: string;
  date: string;          // ISO string
  eventType: string;     // human-readable label
  source: "radarr" | "sonarr" | "jellyseerr" | "jellyfin" | "qbittorrent";
  detail: string | null;
  icon: "download" | "import" | "request" | "approve" | "decline" | "watch" | "delete" | "info";
  severity: "success" | "info" | "warning" | "error";
}

const RADARR_LABELS: Record<string, { label: string; icon: TimelineEntry["icon"]; severity: TimelineEntry["severity"] }> = {
  grabbed:                { label: "Récupéré",        icon: "download", severity: "info" },
  downloadFolderImported: { label: "Importé",         icon: "import",   severity: "success" },
  movieFolderImported:    { label: "Importé",         icon: "import",   severity: "success" },
  movieFileDeleted:       { label: "Fichier supprimé",icon: "delete",   severity: "warning" },
  downloadFailed:         { label: "Échec dl",        icon: "delete",   severity: "error" },
};

const SONARR_LABELS: Record<string, { label: string; icon: TimelineEntry["icon"]; severity: TimelineEntry["severity"] }> = {
  grabbed:                { label: "Récupéré",        icon: "download", severity: "info" },
  downloadFolderImported: { label: "Importé",         icon: "import",   severity: "success" },
  episodeFileDeleted:     { label: "Fichier supprimé",icon: "delete",   severity: "warning" },
  downloadFailed:         { label: "Échec dl",        icon: "delete",   severity: "error" },
};

const JELLYSEERR_STATUS: Record<number, { label: string; icon: TimelineEntry["icon"]; severity: TimelineEntry["severity"] }> = {
  1: { label: "En attente d'approbation", icon: "request", severity: "info" },
  2: { label: "Approuvé",                 icon: "approve", severity: "success" },
  3: { label: "Refusé",                   icon: "decline", severity: "error" },
  4: { label: "Disponible",               icon: "watch",   severity: "success" },
  5: { label: "Disponible partiellement", icon: "info",    severity: "info" },
};

export async function GET(req: NextRequest) {
  const mediaType = req.nextUrl.searchParams.get("type") as "movie" | "series" | null;
  const radarrId  = parseInt(req.nextUrl.searchParams.get("radarrId")  ?? "0");
  const sonarrId  = parseInt(req.nextUrl.searchParams.get("sonarrId")  ?? "0");
  const tmdbId    = parseInt(req.nextUrl.searchParams.get("tmdbId")    ?? "0");

  if (!mediaType || (!radarrId && !sonarrId)) {
    return NextResponse.json({ events: [] });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  const cacheKey = `timeline:${mediaType}:${radarrId || sonarrId}`;

  const events = await withCache<TimelineEntry[]>(cacheKey, TTL.MEDIUM, async () => {
    const entries: TimelineEntry[] = [];

    if (mediaType === "movie" && radarrId) {
      // Radarr history for this specific movie
      const hist = await radarr.getMovieHistory(radarrId).catch(() => []);
      for (const r of hist) {
        const meta = RADARR_LABELS[r.eventType] ?? { label: r.eventType, icon: "info" as const, severity: "info" as const };
        entries.push({
          id: `radarr-${r.id}`,
          date: r.date,
          eventType: meta.label,
          source: "radarr",
          detail: r.eventType === "grabbed" ? (r.data?.indexer ?? null) : r.data?.message ?? null,
          icon: meta.icon,
          severity: meta.severity,
        });
      }
    }

    if (mediaType === "series" && sonarrId) {
      const hist = await sonarr.getSeriesHistory(sonarrId).catch(() => []);
      for (const r of hist) {
        const meta = SONARR_LABELS[r.eventType] ?? { label: r.eventType, icon: "info" as const, severity: "info" as const };
        const ep = r.episode;
        entries.push({
          id: `sonarr-${r.id}`,
          date: r.date,
          eventType: meta.label,
          source: "sonarr",
          detail: ep
            ? `S${String(ep.seasonNumber).padStart(2,"0")}E${String(ep.episodeNumber).padStart(2,"0")} · ${ep.title ?? ""}`.trim()
            : r.data?.message ?? null,
          icon: meta.icon,
          severity: meta.severity,
        });
      }
    }

    // Jellyseerr request status
    if (tmdbId) {
      const jsType = mediaType === "movie" ? "movie" : "tv";
      const allRequests = await jellyseerr.getRequests("all").catch(() => ({ results: [] }));
      const matching = allRequests.results.filter((r) =>
        r.media?.tmdbId === tmdbId && r.type?.toLowerCase() === jsType
      );
      for (const req of matching) {
        const meta = JELLYSEERR_STATUS[req.status] ?? { label: "Demandé", icon: "request" as const, severity: "info" as const };
        entries.push({
          id: `js-${req.id}`,
          date: req.createdAt,
          eventType: meta.label,
          source: "jellyseerr",
          detail: req.requestedBy?.displayName ?? req.requestedBy?.username ?? null,
          icon: meta.icon,
          severity: meta.severity,
        });
      }
    }

    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return entries;
  });

  return NextResponse.json({ events });
}

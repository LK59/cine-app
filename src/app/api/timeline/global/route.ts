import { NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { withCache, TTL } from "@/lib/server-cache";
import { posterUrl } from "@/lib/images";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export interface GlobalTimelineEntry {
  id: string;
  date: string;
  source: "radarr" | "sonarr" | "jellyseerr";
  eventType: string;
  title: string;
  detail: string | null;
  posterPath: string | null;
  href: string | null;
  icon: "download" | "import" | "request" | "approve" | "decline" | "watch" | "delete" | "info";
  severity: "success" | "info" | "warning" | "error";
}

const RADARR_EVENTS: Record<string, { label: string; icon: GlobalTimelineEntry["icon"]; severity: GlobalTimelineEntry["severity"] }> = {
  grabbed:                { label: "Récupéré",           icon: "download", severity: "info" },
  downloadFolderImported: { label: "Importé",            icon: "import",   severity: "success" },
  movieFolderImported:    { label: "Importé",            icon: "import",   severity: "success" },
  movieFileDeleted:       { label: "Fichier supprimé",   icon: "delete",   severity: "warning" },
  downloadFailed:         { label: "Téléchargement échoué", icon: "delete", severity: "error" },
};

const SONARR_EVENTS: Record<string, { label: string; icon: GlobalTimelineEntry["icon"]; severity: GlobalTimelineEntry["severity"] }> = {
  grabbed:                { label: "Récupéré",           icon: "download", severity: "info" },
  downloadFolderImported: { label: "Importé",            icon: "import",   severity: "success" },
  episodeFileDeleted:     { label: "Fichier supprimé",   icon: "delete",   severity: "warning" },
  downloadFailed:         { label: "Téléchargement échoué", icon: "delete", severity: "error" },
};

const JS_STATUS: Record<number, { label: string; icon: GlobalTimelineEntry["icon"]; severity: GlobalTimelineEntry["severity"] }> = {
  1: { label: "Demandé",                  icon: "request", severity: "info" },
  2: { label: "Approuvé",                 icon: "approve", severity: "success" },
  3: { label: "Refusé",                   icon: "decline", severity: "error" },
  4: { label: "Disponible",               icon: "watch",   severity: "success" },
  5: { label: "Disponible partiellement", icon: "info",    severity: "info" },
};

export async function GET() {
  const events = await withCache<GlobalTimelineEntry[]>("timeline:global", TTL.MEDIUM, async () => {
    const [radarrHist, sonarrHist, jsReqs, movies, series] = await Promise.all([
      radarr.getHistory(30).catch(() => ({ records: [] })),
      sonarr.getHistory(30).catch(() => ({ records: [] })),
      jellyseerr.getRequests("all").catch(() => ({ results: [] })),
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
    ]);

    const moviePosterMap = new Map(movies.map((m) => [m.id, posterUrl(m.images, "thumb")]));
    const seriesPosterMap = new Map(series.map((s) => [s.id, posterUrl(s.images, "thumb")]));

    const entries: GlobalTimelineEntry[] = [];

    for (const r of radarrHist.records) {
      const meta = RADARR_EVENTS[r.eventType] ?? { label: r.eventType, icon: "info" as const, severity: "info" as const };
      entries.push({
        id: `radarr-${r.id}`,
        date: r.date,
        source: "radarr",
        eventType: meta.label,
        title: r.movie?.title ?? r.sourceTitle,
        detail: r.eventType === "grabbed" ? r.data?.indexer ?? null : null,
        posterPath: r.movie?.id ? (moviePosterMap.get(r.movie.id) ?? null) : null,
        href: r.movie?.id ? `/radarr/${r.movie.id}` : null,
        icon: meta.icon,
        severity: meta.severity,
      });
    }

    for (const r of sonarrHist.records) {
      const meta = SONARR_EVENTS[r.eventType] ?? { label: r.eventType, icon: "info" as const, severity: "info" as const };
      const ep = r.episode;
      entries.push({
        id: `sonarr-${r.id}`,
        date: r.date,
        source: "sonarr",
        eventType: meta.label,
        title: r.series?.title ?? r.sourceTitle,
        detail: ep ? `S${String(ep.seasonNumber).padStart(2,"0")}E${String(ep.episodeNumber).padStart(2,"0")}` : null,
        posterPath: r.series?.id ? (seriesPosterMap.get(r.series.id) ?? null) : null,
        href: r.series?.id ? `/sonarr/${r.series.id}` : null,
        icon: meta.icon,
        severity: meta.severity,
      });
    }

    for (const req of jsReqs.results.slice(0, 30)) {
      const meta = JS_STATUS[req.status] ?? { label: "Demandé", icon: "request" as const, severity: "info" as const };
      entries.push({
        id: `js-${req.id}`,
        date: req.createdAt,
        source: "jellyseerr",
        eventType: meta.label,
        title: req.media.title ?? "Média",
        detail: req.requestedBy?.displayName ?? req.requestedBy?.username ?? null,
        posterPath: null,
        href: "/jellyseerr",
        icon: meta.icon,
        severity: meta.severity,
      });
    }

    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return entries.slice(0, 60);
  });

  return NextResponse.json({ events });
}

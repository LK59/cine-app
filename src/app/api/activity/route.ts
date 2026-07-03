import { NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { jellyseerr } from "@/lib/clients/jellyseerr";

export interface ActivityItem {
  id: string;
  date: string;
  source: "radarr" | "sonarr" | "jellyseerr";
  type: string;
  title: string;
  detail?: string;
  href?: string;
}

const RADARR_EVENT_LABELS: Record<string, string> = {
  grabbed: "Récupéré",
  downloadFolderImported: "Importé",
  movieFileDeleted: "Supprimé",
  movieFolderImported: "Importé",
  downloadFailed: "Téléchargement échoué",
};

const SONARR_EVENT_LABELS: Record<string, string> = {
  grabbed: "Récupéré",
  downloadFolderImported: "Importé",
  episodeFileDeleted: "Supprimé",
  downloadFailed: "Téléchargement échoué",
};

export async function GET() {
  const [radarrHistory, sonarrHistory, jellyseerrRequests] = await Promise.all([
    radarr.getHistory(15).catch(() => ({ records: [] })),
    sonarr.getHistory(15).catch(() => ({ records: [] })),
    jellyseerr.getRequests("all").catch(() => ({ results: [] })),
  ]);

  const items: ActivityItem[] = [];

  for (const r of radarrHistory.records) {
    items.push({
      id: `radarr-${r.id}`,
      date: r.date,
      source: "radarr",
      type: RADARR_EVENT_LABELS[r.eventType] ?? r.eventType,
      title: r.movie?.title ?? r.sourceTitle,
      detail: r.eventType === "grabbed" ? r.data?.indexer : undefined,
      href: r.movie?.id ? `/radarr/${r.movie.id}` : undefined,
    });
  }

  for (const r of sonarrHistory.records) {
    const episode = r.episode;
    items.push({
      id: `sonarr-${r.id}`,
      date: r.date,
      source: "sonarr",
      type: SONARR_EVENT_LABELS[r.eventType] ?? r.eventType,
      title: r.series?.title ?? r.sourceTitle,
      detail: episode
        ? `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`
        : undefined,
      href: r.series?.id ? `/sonarr/${r.series.id}` : undefined,
    });
  }

  for (const req of jellyseerrRequests.results.slice(0, 15)) {
    items.push({
      id: `jellyseerr-${req.id}`,
      date: req.createdAt,
      source: "jellyseerr",
      type: "Demande",
      title: req.media.title ?? "Demande média",
      detail: req.requestedBy?.displayName ?? req.requestedBy?.username,
      href: "/jellyseerr",
    });
  }

  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return NextResponse.json(items.slice(0, 25));
}

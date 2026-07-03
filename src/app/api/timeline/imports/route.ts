import { NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { withCache, TTL, cachedMovies } from "@/lib/server-cache";
import { posterUrl } from "@/lib/images";

export const dynamic = "force-dynamic";

// Events kept in timeline — only download & import events (not deletions, etc.)
const RADARR_KEEP = new Set(["grabbed", "downloadFolderImported", "movieFolderImported"]);
const SONARR_KEEP = new Set(["grabbed", "downloadFolderImported"]);

export interface ImportEvent {
  id: string;
  date: string;
  type: "movie" | "series";
  title: string;
  detail: string | null;
  posterPath: string | null;
  href: string | null;
  source: "radarr" | "sonarr";
  eventKind: "import" | "grab";
}

export async function GET() {
  const events = await withCache<ImportEvent[]>("timeline:imports", TTL.MEDIUM, async () => {
    const [radarrHist, sonarrHist, movies] = await Promise.all([
      radarr.getHistory(50).catch(() => ({ records: [] })),
      sonarr.getHistory(50).catch(() => ({ records: [] })),
      cachedMovies().catch(() => []),
    ]);

    const moviePosterMap = new Map(movies.map((m) => [m.id, posterUrl(m.images, "thumb")]));

    const entries: ImportEvent[] = [];

    for (const r of radarrHist.records) {
      if (!RADARR_KEEP.has(r.eventType)) continue;
      const isImport = r.eventType !== "grabbed";
      entries.push({
        id: `radarr-${r.id}`,
        date: r.date,
        type: "movie",
        title: r.movie?.title ?? r.sourceTitle ?? "Inconnu",
        detail: isImport
          ? (r.quality?.quality?.name ?? null)
          : (r.data?.indexer ?? null),
        posterPath: r.movie?.id ? (moviePosterMap.get(r.movie.id) ?? null) : null,
        href: r.movie?.id ? `/radarr/${r.movie.id}` : null,
        source: "radarr",
        eventKind: isImport ? "import" : "grab",
      });
    }

    for (const r of sonarrHist.records) {
      if (!SONARR_KEEP.has(r.eventType)) continue;
      const isImport = r.eventType !== "grabbed";
      const ep = r.episode;
      let detail: string | null = null;
      if (ep) {
        detail = `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`;
        if (ep.title) detail += ` · ${ep.title}`;
      } else if (!isImport) {
        detail = r.data?.indexer ?? null;
      }
      entries.push({
        id: `sonarr-${r.id}`,
        date: r.date,
        type: "series",
        title: r.series?.title ?? r.sourceTitle ?? "Inconnu",
        detail,
        posterPath: r.series?.images ? (posterUrl(r.series.images, "thumb") ?? null) : null,
        href: r.series?.id ? `/sonarr/${r.series.id}` : null,
        source: "sonarr",
        eventKind: isImport ? "import" : "grab",
      });
    }

    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return entries.slice(0, 50);
  });

  return NextResponse.json({ events });
}

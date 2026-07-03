import { NextRequest, NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { withCache, TTL } from "@/lib/server-cache";
import { config } from "@/lib/config";
import { posterUrl } from "@/lib/images";

export const dynamic = "force-dynamic";

export interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  type: "movie" | "series";
  // cinema = TMDb now_playing (not in library), upcoming = TMDb upcoming, library-movie/series = Radarr/Sonarr
  source: "cinema" | "upcoming" | "library-movie" | "library-series";
  posterPath: string | null;
  href: string | null;
  detail: string | null;
  tmdbId?: number;
}

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG  = "https://image.tmdb.org/t/p/w185";

async function fetchTmdbPage(path: string): Promise<{ results: any[] }> {
  const key = config.tmdb.apiKey;
  if (!key) return { results: [] };
  const url = `${TMDB_BASE}${path}&api_key=${key}&language=fr-FR&region=FR`;
  const res = await fetch(url, { next: { revalidate: 3600 } });
  if (!res.ok) return { results: [] };
  return res.json();
}

async function getTmdbMovies(type: "now_playing" | "upcoming"): Promise<CalendarEvent[]> {
  const [page1, page2] = await Promise.all([
    fetchTmdbPage(`/movie/${type}?page=1`),
    fetchTmdbPage(`/movie/${type}?page=2`),
  ]);
  const results = [...page1.results, ...page2.results];
  return results
    .filter((m) => m.release_date)
    .map((m) => ({
      id: `tmdb-${type}-${m.id}`,
      date: m.release_date,
      title: m.title,
      type: "movie" as const,
      source: type === "now_playing" ? "cinema" as const : "upcoming" as const,
      posterPath: m.poster_path ? `${TMDB_IMG}${m.poster_path}` : null,
      href: null,
      detail: type === "now_playing" ? "Au cinéma" : "Bientôt",
      tmdbId: m.id,
    }));
}

export async function GET(req: NextRequest) {
  const start = req.nextUrl.searchParams.get("start") ?? new Date().toISOString().slice(0, 10);
  const end   = req.nextUrl.searchParams.get("end")   ?? new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

  const cacheKey = `calendar:${start}:${end}`;

  const events = await withCache<CalendarEvent[]>(cacheKey, TTL.SHORT * 3, async () => {
    const [radarrMovies, sonarrEps, tmdbNow, tmdbUp] = await Promise.allSettled([
      radarr.getCalendar(start, end),
      sonarr.getCalendar(start, end),
      getTmdbMovies("now_playing"),
      getTmdbMovies("upcoming"),
    ]);

    const list: CalendarEvent[] = [];

    // Radarr — movies in library with upcoming release dates
    if (radarrMovies.status === "fulfilled") {
      const libraryTmdbIds = new Set(radarrMovies.value.map((m) => m.tmdbId));
      for (const m of radarrMovies.value) {
        const date = (m.digitalRelease || m.physicalRelease || m.inCinemas)?.slice(0, 10);
        if (!date) continue;
        const releaseLabel = m.inCinemas && m.inCinemas.slice(0, 10) === date
          ? "Au cinéma"
          : m.digitalRelease && m.digitalRelease.slice(0, 10) === date
            ? "Sortie digitale"
            : "Sortie physique";
        list.push({
          id: `radarr-${m.id}`,
          date,
          title: m.title,
          type: "movie",
          source: "library-movie",
          posterPath: posterUrl(m.images, "thumb") ?? null,
          href: `/radarr/${m.id}`,
          detail: releaseLabel,
          tmdbId: m.tmdbId,
        });
      }

      // TMDb cinema — exclude movies already in Radarr library
      if (tmdbNow.status === "fulfilled") {
        for (const ev of tmdbNow.value) {
          if (ev.tmdbId && libraryTmdbIds.has(ev.tmdbId)) continue;
          list.push(ev);
        }
      }
      if (tmdbUp.status === "fulfilled") {
        for (const ev of tmdbUp.value) {
          if (ev.tmdbId && libraryTmdbIds.has(ev.tmdbId)) continue;
          list.push(ev);
        }
      }
    } else {
      if (tmdbNow.status === "fulfilled") list.push(...tmdbNow.value);
      if (tmdbUp.status === "fulfilled") list.push(...tmdbUp.value);
    }

    // Sonarr — upcoming episodes
    if (sonarrEps.status === "fulfilled") {
      for (const e of sonarrEps.value) {
        const date = e.airDate?.slice(0, 10);
        if (!date) continue;
        const s = String(e.seasonNumber).padStart(2, "0");
        const ep = String(e.episodeNumber).padStart(2, "0");
        list.push({
          id: `sonarr-${e.id}`,
          date,
          title: e.series?.title ?? "Série",
          type: "series",
          source: "library-series",
          posterPath: posterUrl(e.series?.images, "thumb") ?? null,
          href: `/sonarr/${e.seriesId}`,
          detail: `S${s}E${ep} · ${e.title}`,
          tmdbId: undefined,
        });
      }
    }

    // Deduplicate by id
    const seen = new Set<string>();
    return list
      .filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
      .sort((a, b) => a.date.localeCompare(b.date));
  });

  return NextResponse.json({ events });
}

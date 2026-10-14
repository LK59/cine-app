import { NextRequest, NextResponse } from "next/server";
import { sonarr } from "@/lib/clients/sonarr";
import { bazarr } from "@/lib/clients/bazarr";
import { createTmdbClient, pickTrailer } from "@/lib/clients/tmdb";
import { seriesTmdbFacts } from "@/lib/titleInfoShape";
import { jellyfinOnlyInfo } from "@/lib/jellyfinOnlyInfo";
import { getTmdbLocale, localeOf } from "@/lib/i18n";
import { cachedOmdbRating, cachedSonarrQueue, cachedTmdbIdForTvdb, cachedTmdbTvInfo, hiddenFromCaller } from "@/lib/titleInfoCache";
import { getTitleLogoFor } from "@/lib/title-logo";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const lang = getTmdbLocale(req.cookies.get("cine-lang")?.value);
  const tmdb = createTmdbClient(lang);
  const id = Number(params.id);
  // Une série que Jellyfin a seule (DECISIONS.md §89) : rien à demander à Sonarr ni à Bazarr.
  const onlyInJellyfin = await jellyfinOnlyInfo(req, "series", id);
  if (onlyInJellyfin) return onlyInJellyfin;
  const series = await sonarr.getSeriesById(id).catch(() => null);
  if (!series) return NextResponse.json({ error: "Série introuvable" }, { status: 404 });
  // Cachée par les tags bloqués du compte : elle n'existe pas pour lui (DECISIONS.md §54).
  if (series.tmdbId && (await hiddenFromCaller(req, `series:${series.tmdbId}`))) {
    return NextResponse.json({ error: "Série introuvable" }, { status: 404 });
  }

  // Resolve TMDB TV id from TVDB first (needed for videos too) — une correspondance gardée, voir
  // `titleInfoCache.ts`, comme les détails, les vidéos, la note et la file.
  const tmdbTvId = tmdb.isEnabled() ? await cachedTmdbIdForTvdb(tmdb, series.tvdbId).catch(() => null) : null;

  const [tmdbPart, rating, episodeSubtitles, queue, logoUrl] = await Promise.all([
    tmdbTvId ? cachedTmdbTvInfo(tmdb, lang, tmdbTvId).catch(() => null) : Promise.resolve(null),
    series.imdbId ? cachedOmdbRating(series.imdbId).catch(() => null) : Promise.resolve(null),
    bazarr.getEpisodesDetails(id).catch(() => []),
    cachedSonarrQueue().catch(() => ({ records: [] as any[] })),
    // Voir la route des films : le même logo, la même mise en cache, la même raison.
    tmdbTvId ? getTitleLogoFor(tmdbTvId, "series", localeOf(req)) : Promise.resolve(null),
  ]);

  const tmdbInfo = tmdbPart?.details ?? null;
  const tmdbVideos = tmdbPart?.videos ?? { results: [] };
  const activeDownloads = queue.records.filter((r: any) => r.seriesId === id);

  const trailer = pickTrailer(tmdbVideos.results);

  return NextResponse.json({
    logoUrl,
    trailerKey: trailer?.key ?? null,
    tmdb: tmdbInfo ? seriesTmdbFacts(tmdbInfo, series.runtime) : null,
    // Pour les notes critiques de la fenêtre « Voir plus » (MDBList) — voir `CinemaRatingsLine`.
    imdbId: series.imdbId || null,
    imdbRating: rating && rating.Response === "True" ? rating.imdbRating : null,
    imdbVotes: rating && rating.Response === "True" ? rating.imdbVotes : null,
    episodeSubtitles,
    activeDownloads: activeDownloads.map((r: any) => ({
      episodeId: r.episodeId,
      title: r.title,
      status: r.status,
      trackedDownloadStatus: r.trackedDownloadStatus,
      size: r.size,
      sizeleft: r.sizeleft,
      indexer: r.indexer,
    })),
  });
}

import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { tmdb } from "@/lib/clients/tmdb";
import { resolveTrailerKey } from "@/lib/trailerKey";
import { downloadTrailer, getLocalTrailerPath, DOWNLOAD_CONCURRENCY, type TrailerMediaType } from "@/lib/trailerDownload";
import { trailerDb } from "@/lib/db";
import { logError } from "@/lib/logger";

// Same "computing" in-memory guard disk-stats.ts/storage-scan.ts already use to prevent
// overlapping runs — the SQLite job row is for progress reporting across requests, this flag is
// just for "don't start a second run while one's already going" within this process.
let jobRunning = false;

export function isTrailerJobRunning(): boolean {
  return jobRunning;
}

// Runs `worker` over `items` with at most `limit` in flight at once. One item throwing doesn't
// abort the rest — the caller decides what a thrown/rejected worker means (here: counted as a
// failure, batch keeps going), same "don't let one bad title take down 800 others" reasoning as
// downloadTrailer's own per-stage try/catch.
export async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runNext(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
}

interface Target {
  mediaType: TrailerMediaType;
  tmdbId: number;
}

async function resolveTrailerKeyForTarget(target: Target): Promise<string | null> {
  if (!tmdb.isEnabled()) return null;
  try {
    const videos = target.mediaType === "movie" ? await tmdb.getMovieVideos(target.tmdbId) : await tmdb.getTvVideos(target.tmdbId);
    return resolveTrailerKey(videos);
  } catch {
    return null;
  }
}

// "full": re-download everything (the manual "Télécharger maintenant" button). "missing-only":
// only titles without a local file yet (the periodic top-up cron, for newly-added titles).
export async function runTrailerJob(scope: "full" | "missing-only"): Promise<void> {
  if (jobRunning) return;
  jobRunning = true;
  let jobId: number | null = null;

  try {
    const [movies, series] = await Promise.all([cachedMovies(), cachedSeries()]);

    const targets: Target[] = [
      ...movies.filter((m) => m.hasFile).map((m) => ({ mediaType: "movie" as const, tmdbId: m.tmdbId })),
      ...series
        .filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0 && s.tmdbId != null)
        .map((s) => ({ mediaType: "series" as const, tmdbId: s.tmdbId! })),
    ].filter((t) => scope === "full" || !getLocalTrailerPath(t.tmdbId, t.mediaType));

    jobId = trailerDb.startJob(targets.length);
    let completed = 0;
    let failed = 0;

    await runWithConcurrency(targets, DOWNLOAD_CONCURRENCY, async (target) => {
      const key = await resolveTrailerKeyForTarget(target);
      const result = key ? await downloadTrailer(target.tmdbId, target.mediaType, key) : { ok: false as const };
      if (result.ok) completed++;
      else failed++;
      trailerDb.updateJobProgress(jobId!, completed, failed);
    });

    trailerDb.finishJob(jobId, "done");
  } catch (err) {
    logError("trailer.job", err);
    if (jobId !== null) trailerDb.finishJob(jobId, "error");
  } finally {
    jobRunning = false;
  }
}

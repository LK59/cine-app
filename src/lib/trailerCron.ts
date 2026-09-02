import { trailerDb } from "@/lib/db";
import { runTrailerJob } from "@/lib/trailerJob";
import { logError } from "@/lib/logger";

// Trailer availability isn't time-critical — this only matters for catching up newly-added
// titles between now and whenever someone next hits "Télécharger maintenant" — so a coarse
// interval is fine, unlike statusCron's 60s health-check cadence.
const POLL_INTERVAL_MS = 6 * 3600_000;

async function runTrailerTopUp(): Promise<void> {
  try {
    const { autoPreviewEnabled } = trailerDb.getSettings();
    if (!autoPreviewEnabled) return; // feature off — nothing to keep topped up
    await runTrailerJob("missing-only");
  } catch (err) {
    logError("trailer.cron", err);
  }
}

export function startTrailerCron(): void {
  const startupDelay = setTimeout(runTrailerTopUp, 30_000); // after cache warmup gets a head start
  startupDelay.unref?.();

  const pollInterval = setInterval(runTrailerTopUp, POLL_INTERVAL_MS);
  pollInterval.unref?.();
}

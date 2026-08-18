import { runAllServiceChecks, computeCapabilities } from "@/lib/healthChecks";
import { statusHistoryDb, diskUsageDb } from "@/lib/db";
import { recordDiskUsageSample } from "@/lib/diskForecast";
import { logError } from "@/lib/logger";

// 60s gives incident detection (see statusHistory.ts) fine enough granularity to tell a brief
// container restart apart from a real outage — a longer interval would blur the two together.
const POLL_INTERVAL_MS = 60_000;
const RETENTION_MS = 35 * 24 * 3600_000;
const DISK_RETENTION_MS = 90 * 24 * 3600_000;

export async function runStatusPoll(): Promise<void> {
  try {
    const services = await runAllServiceChecks();
    const checkedAt = Date.now();

    statusHistoryDb.recordServiceChecks(
      Object.fromEntries(Object.entries(services).map(([key, r]) => [key, { status: r.status, latencyMs: r.latencyMs }])),
      checkedAt
    );

    const capabilities = computeCapabilities(services);
    statusHistoryDb.recordCapabilityChecks(
      capabilities.map((c) => ({ id: c.id, status: c.status })),
      checkedAt
    );
  } catch (err) {
    logError("status.poll", err);
  }
}

function hourlyTick(): void {
  try {
    statusHistoryDb.cleanup(RETENTION_MS);
  } catch (err) {
    logError("status.cleanup", err);
  }
  try {
    recordDiskUsageSample();
    diskUsageDb.cleanup(DISK_RETENTION_MS);
  } catch (err) {
    logError("status.diskSample", err);
  }
}

export function startStatusCron(): void {
  const startupDelay = setTimeout(() => {
    runStatusPoll();
    recordDiskUsageSample();
  }, 10_000);
  startupDelay.unref?.();

  const pollInterval = setInterval(() => {
    runStatusPoll();
  }, POLL_INTERVAL_MS);
  pollInterval.unref?.();

  const hourlyInterval = setInterval(hourlyTick, 3600_000);
  hourlyInterval.unref?.();
}

export { POLL_INTERVAL_MS };

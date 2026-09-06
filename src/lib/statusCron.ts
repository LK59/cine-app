import { runAllServiceChecks, computeCapabilities } from "@/lib/healthChecks";
import { statusHistoryDb } from "@/lib/db";
import { logError } from "@/lib/logger";

// 60s gives incident detection (see statusHistory.ts) fine enough granularity to tell a brief
// container restart apart from a real outage — a longer interval would blur the two together.
const POLL_INTERVAL_MS = 60_000;
/**
 * Dix jours, parce que sept sont lus.
 *
 * La page d'état publique — seule lectrice de cet historique — demande exactement une fenêtre de
 * sept jours pour son pourcentage de disponibilité et sa liste d'incidents. On en gardait
 * trente-cinq : quatre lignes sur cinq étaient stockées, sauvegardées et parcourues à chaque
 * ménage sans que rien ne les regarde jamais, pour cent dix-sept mégaoctets de base.
 *
 * Dix laissent trois jours de marge à qui voudrait élargir la fenêtre, sans rien changer à ce qui
 * s'affiche : la résolution reste la minute, ce sont les vieilles lignes qui partent.
 */
const RETENTION_MS = 10 * 24 * 3600_000;

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

function cleanupStatusHistory(): void {
  try {
    statusHistoryDb.cleanup(RETENTION_MS);
  } catch (err) {
    logError("status.cleanup", err);
  }
}

export function startStatusCron(): void {
  const startupDelay = setTimeout(() => {
    runStatusPoll();
  }, 10_000);
  startupDelay.unref?.();

  const pollInterval = setInterval(() => {
    runStatusPoll();
  }, POLL_INTERVAL_MS);
  pollInterval.unref?.();

  const cleanupInterval = setInterval(cleanupStatusHistory, 3600_000);
  cleanupInterval.unref?.();
}

export { POLL_INTERVAL_MS };

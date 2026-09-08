import { runAllServiceChecks, computeCapabilities, type CapabilityResult } from "@/lib/healthChecks";
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

export interface StatusSnapshot {
  capabilities: CapabilityResult[];
  /** Date du passage qui a produit cet état, en millisecondes epoch. */
  checkedAt: number;
}

/**
 * Ce que le dernier passage a vu, gardé en mémoire pour que la page d'état n'ait rien à refaire.
 *
 * `capability_checks` porte déjà l'historique, mais pas la forme complète d'une capacité : la
 * table stocke un identifiant et un statut, jamais la note ni les dépendances, qui se déduisent
 * des douze services et changent avec eux. Plutôt que de recalculer ces douze appels amont à
 * chaque ouverture de /status — ce que faisait la route, quatre fois par minute et par onglet —
 * le cron garde son propre résultat sous la main. Il l'a déjà payé.
 *
 * En mémoire, donc perdu au redémarrage : c'est voulu, et c'est exactement pourquoi la route a
 * un repli. Une capacité rendue depuis une base après un redéploiement dirait l'état du
 * conteneur d'avant.
 *
 * Sur `globalThis` et pas dans une variable de module, parce que l'écrivain et le lecteur
 * n'entrent pas par la même porte : le cron démarre depuis `instrumentation.ts`, la page d'état
 * lit depuis une route d'API, et ce sont deux points d'entrée que le bundler compile séparément.
 * Rien ne garantit qu'ils partagent l'instance de ce module — et si l'écriture atterrissait dans
 * une copie que la route ne lit pas, le repli masquerait la panne : la page continuerait de
 * répondre, en repayant à chaque fois le prix qu'on cherche précisément à ne plus payer.
 */
const SNAPSHOT_KEY = Symbol.for("cine-app.statusSnapshot");
type SnapshotHolder = { [SNAPSHOT_KEY]?: StatusSnapshot | null };

export function getLastStatusSnapshot(): StatusSnapshot | null {
  return (globalThis as SnapshotHolder)[SNAPSHOT_KEY] ?? null;
}

export async function runStatusPoll(): Promise<void> {
  try {
    const services = await runAllServiceChecks();
    const checkedAt = Date.now();

    statusHistoryDb.recordServiceChecks(
      Object.fromEntries(Object.entries(services).map(([key, r]) => [key, { status: r.status, latencyMs: r.latencyMs }])),
      checkedAt
    );

    const capabilities = computeCapabilities(services);
    (globalThis as SnapshotHolder)[SNAPSHOT_KEY] = { capabilities, checkedAt };
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

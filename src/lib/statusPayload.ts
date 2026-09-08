import { runAllServiceChecks, computeCapabilities, type CapabilityResult, type CheckStatus } from "@/lib/healthChecks";
import { statusHistoryDb } from "@/lib/db";
import { analyzeHistory, type Incident } from "@/lib/statusHistory";
import { POLL_INTERVAL_MS, getLastStatusSnapshot } from "@/lib/statusCron";

const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

/**
 * Au-delà de quoi l'état gardé en mémoire cesse de valoir mieux que rien.
 *
 * Trois passages manqués : ce n'est plus un cron en retard, c'est un cron qui ne tourne pas —
 * exception dans `runStatusPoll`, processus qui vient de démarrer (le premier passage attend dix
 * secondes), ou tâche jamais lancée. Dans ce cas la route recalcule elle-même : /status est la
 * page qu'on ouvre quand plus rien ne marche, elle doit répondre quelque chose de vrai même —
 * surtout — quand c'est le cron qui est cassé. Deux passages seraient trop serrés : un relevé
 * dure jusqu'à cinq secondes (timeout des pings) et l'intervalle ne l'attend pas.
 */
const SNAPSHOT_MAX_AGE_MS = 3 * POLL_INTERVAL_MS;

export interface StatusCapabilityPayload {
  id: string;
  status: CheckStatus;
  note: string | null;
  dependsOn: CapabilityResult["dependsOn"];
  softDependsOn: CapabilityResult["softDependsOn"];
  uptime7d: number;
  incidents7d: Incident[];
}

export interface StatusPayload {
  overall: CheckStatus;
  /** Date de l'état rendu — celle du relevé, pas celle de la requête. */
  checkedAt: string;
  /** Vrai quand les services viennent d'être interrogés pour cette requête même. */
  live: boolean;
  capabilities: StatusCapabilityPayload[];
}

/**
 * L'historique de sept jours, recalculé une fois par relevé et pas une fois par requête.
 *
 * C'est le vrai coût de cette page : trente et une requêtes SQL, trois cent quatre-vingt-treize
 * mille lignes remontées jusqu'à JavaScript, trois cents millisecondes — et better-sqlite3 est
 * synchrone, donc trois cents millisecondes pendant lesquelles rien d'autre n'est servi, pas même
 * un segment de film. Or ces lignes ne bougent qu'au passage du cron : entre deux passages, la
 * réponse est identique au bit près. On la garde.
 *
 * La clé, c'est la date du dernier relevé. Sans relevé (cron cassé, démarrage), on retombe sur
 * une tranche de la taille de l'intervalle : la base n'est alors pas écrite non plus, et un
 * rafraîchissement forcé n'a aucune raison de repayer ce que personne n'a modifié.
 */
let historyCache: { key: string; byCapability: Map<string, { uptimePct: number; incidents: Incident[] }> } | null = null;

function capabilityHistory(ids: string[]) {
  const snapshotAt = getLastStatusSnapshot()?.checkedAt ?? 0;
  const key = snapshotAt > 0 ? `s${snapshotAt}` : `t${Math.floor(Date.now() / POLL_INTERVAL_MS)}`;
  if (historyCache?.key === key) return historyCache.byCapability;

  const since = Date.now() - SEVEN_DAYS_MS;
  const byCapability = new Map<string, { uptimePct: number; incidents: Incident[] }>();
  for (const id of ids) {
    byCapability.set(id, analyzeHistory(statusHistoryDb.getCapabilityHistory(id, since), POLL_INTERVAL_MS));
  }
  historyCache = { key, byCapability };
  return byCapability;
}

/**
 * L'état des capacités, servi depuis le dernier relevé du cron sauf demande contraire.
 *
 * `force` est le bouton « rafraîchir maintenant » : il paie les douze appels amont pour rendre
 * l'instant présent, ce dont on a besoin quand on regarde la page pendant qu'on répare quelque
 * chose. Sans lui, la page rapide et le diagnostic en direct seraient incompatibles.
 */
export async function buildStatusPayload(force: boolean): Promise<StatusPayload> {
  const snapshot = getLastStatusSnapshot();
  const usable = !force && snapshot !== null && Date.now() - snapshot.checkedAt <= SNAPSHOT_MAX_AGE_MS;

  let capabilities: CapabilityResult[];
  let checkedAt: number;
  if (usable && snapshot) {
    capabilities = snapshot.capabilities;
    checkedAt = snapshot.checkedAt;
  } else {
    capabilities = computeCapabilities(await runAllServiceChecks());
    checkedAt = Date.now();
  }

  const history = capabilityHistory(capabilities.map((c) => c.id));
  const payload = capabilities.map((cap) => {
    const { uptimePct, incidents } = history.get(cap.id) ?? { uptimePct: 100, incidents: [] };
    return {
      id: cap.id,
      status: cap.status,
      note: cap.note,
      dependsOn: cap.dependsOn,
      softDependsOn: cap.softDependsOn,
      uptime7d: uptimePct,
      incidents7d: incidents.slice(0, 10),
    };
  });

  const overall: CheckStatus = payload.every((c) => c.status === "ok")
    ? "ok"
    : payload.some((c) => c.status === "down")
      ? "down"
      : "degraded";

  return { overall, checkedAt: new Date(checkedAt).toISOString(), live: !usable, capabilities: payload };
}

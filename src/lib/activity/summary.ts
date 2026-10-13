import type { AccountSummary, WeekSignals } from "@/lib/activity/accounts";
import type { ReportSummary } from "@/lib/reports";

/**
 * Les comptes « là » en ce moment, et ceux qui regardent — la règle de la vue en direct du panneau
 * Activité, écrite une fois : l'accueil de la gestion en montre le résumé (DECISIONS.md §81), et
 * deux comptes « actifs » qui ne diraient pas la même chose aux deux endroits se contrediraient.
 *
 * Sans import de valeur : ce module part dans le navigateur, `accounts.ts` lit des fichiers.
 */
export function liveAccounts(accounts: readonly AccountSummary[]): { live: AccountSummary[]; playing: number } {
  const live = accounts.filter((a) => a.nowPlaying || a.presence.state !== "away");
  const playing = live.filter((a) => a.nowPlaying || a.presence.state === "playing").length;
  return { live, playing };
}

/** Un signalement attend une réponse tant qu'il est ouvert ou en cours — comme dans le panneau. */
export function pendingReports(reports: readonly ReportSummary[]): ReportSummary[] {
  return reports.filter((r) => r.status === "open" || r.status === "in_progress");
}

export interface ActivityDigest {
  /** Comptes présents (application ouverte ou film en cours). */
  active: number;
  /** Séances en cours. */
  playing: number;
  /** Signalements qui attendent ; `null` tant que la liste n'est pas arrivée. */
  pendingReports: number | null;
  /** Les erreurs de la semaine (depuis le dernier « Effacer les alertes ») : serveur, navigateur, lecteur. */
  errors: { server: number; client: number; player: number };
  /** Les portées d'erreur serveur les plus fréquentes, trois au plus. */
  topServerErrors: { scope: string; count: number }[];
}

/** Le résumé de l'Activité que montre l'accueil de la gestion — rien d'autre que ce que le panneau compte. */
export function activityDigest(
  overview: { accounts: AccountSummary[]; signals: WeekSignals },
  reports: readonly ReportSummary[] | null,
): ActivityDigest {
  const { live, playing } = liveAccounts(overview.accounts);
  const server = overview.signals.serverErrors.reduce((n, e) => n + e.count, 0);
  return {
    active: live.length,
    playing,
    pendingReports: reports ? pendingReports(reports).length : null,
    errors: { server, client: overview.signals.clientErrors, player: overview.signals.errors },
    topServerErrors: [...overview.signals.serverErrors].sort((a, b) => b.count - a.count).slice(0, 3),
  };
}

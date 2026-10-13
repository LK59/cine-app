export type CheckStatus = "ok" | "degraded" | "down";

/**
 * Ce relevé est-il celui d'un service branché ? Une seule question, posée par la page Santé, la
 * page d'état et le relevé du cron — pour qu'aucun des trois ne recompte une absence en panne
 * (13/10/2026). Module à part, sans dépendance : la page d'état le lit sans charger les sondes.
 */
export function isConfiguredCheck(h: { configured?: boolean } | undefined): boolean {
  return h?.configured !== false;
}

/**
 * L'état d'ensemble d'une liste de relevés, sans ce qui n'est pas configuré : une installation
 * sans Jackett lisait « en panne » en tête de la page d'état, à vie.
 */
export function overallStatus(items: { status: CheckStatus; configured?: boolean }[]): CheckStatus {
  const counted = items.filter(isConfiguredCheck);
  if (counted.every((c) => c.status === "ok")) return "ok";
  return counted.some((c) => c.status === "down") ? "down" : "degraded";
}

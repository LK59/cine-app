/**
 * Une ligne lisible dans le journal du conteneur (`docker logs`) pour ce que fait une tâche de fond
 * du serveur : une vérification qui envoie une notification, une sauvegarde, une préparation hors
 * ligne, un service qui tombe ou revient, une passe de la bibliothèque (25/10/2026, souhait du
 * propriétaire). Avant, la plupart ne disaient rien, et celles qui parlaient écrivaient le JSON de
 * `server.log` tel quel — illisible à l'œil.
 *
 * `[tâche] ce qui s'est passé · clé=valeur …`, une ligne par **action**, jamais par tour d'horloge :
 * une vérification qui ne trouve rien se tait. `server.log` garde ses lignes JSON, inchangées : ceci
 * n'est que la console.
 */

/** Au plus ce nombre de détails, chacun coupé à cette longueur : une ligne, pas un objet. */
const MAX_DETAILS = 6;
const MAX_VALUE = 80;

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (typeof value === "boolean") return value ? "oui" : "non";
  if (typeof value === "string") return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
    return formatValue(value.join(", "));
  }
  return null;
}

/** La ligne elle-même — exportée pour les tests. */
export function taskLine(task: string, message: string, details: Record<string, unknown> = {}): string {
  const parts = Object.entries(details)
    .map(([key, value]) => {
      const shown = formatValue(value);
      return shown === null ? null : `${key}=${shown}`;
    })
    .filter((part): part is string => part !== null)
    .slice(0, MAX_DETAILS);
  return `[${task}] ${message}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

export function taskLog(task: string, message: string, details?: Record<string, unknown>): void {
  console.log(taskLine(task, message, details));
}

export function taskError(task: string, message: string, details?: Record<string, unknown>): void {
  console.error(taskLine(task, message, details));
}

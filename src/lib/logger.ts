import path from "node:path";
import { LOG_DIR, appendJsonLine } from "@/lib/logFile";

// Minimal structured logging — no external dependency, still readable via
// `docker logs`, but each line is a single JSON object so it can be grepped
// or parsed (e.g. `docker logs cine-app | jq 'select(.scope=="qbittorrent")'`).

/**
 * Et sur disque, parce que `docker logs` ne survit pas au déploiement.
 *
 * Le conteneur est recréé à chaque mise à jour, et l'application est redéployée plusieurs fois
 * par jour : une erreur qu'un spectateur rencontre le soir a disparu avant qu'on la cherche. La
 * seule classe de panne qu'on ne pouvait pas instruire était donc celle du serveur — alors même
 * que le journal du lecteur, lui, est écrit dans un fichier depuis le début, et que c'est
 * précisément lui qui a permis de trouver les vraies causes plutôt que de les deviner.
 *
 * Les deux sorties, et pas l'une ou l'autre : la console reste ce qu'on regarde en direct pendant
 * qu'on travaille, le fichier ce qu'on relit après coup.
 */
const SERVER_LOG_FILE = path.join(LOG_DIR, "server.log");

/**
 * Trois générations : depuis qu'il reçoit aussi les erreurs des navigateurs, une boucle d'erreurs
 * sur un seul téléphone peut remplir 5 Mo en une soirée, et l'unique archive d'avant emportait
 * alors les erreurs serveur des jours précédents.
 */
const SERVER_LOG_KEEP = 3;

export function logError(scope: string, err: unknown, context?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "error",
    scope,
    message: err instanceof Error ? err.message : String(err),
    ...context,
  };
  console.error(JSON.stringify(entry));
  /**
   * La pile, sur disque seulement.
   *
   * Elle est ce qui distingue « Jellyfin a refusé » de « on a appelé Jellyfin depuis un endroit
   * qu'on ne soupçonnait pas », et c'est exactement ce qu'on veut relire après coup. Elle
   * encombrerait la console en direct, où le message suffit — d'où sa présence ici et là seule.
   */
  appendJsonLine(SERVER_LOG_FILE, {
    ...entry,
    stack: err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 6).join(" | ") : undefined,
  }, { keep: SERVER_LOG_KEEP });
}


/**
 * Une erreur née dans un navigateur, au même journal que celles du serveur.
 *
 * Le même fichier et non un troisième : une panne se lit le plus souvent des deux côtés à la fois
 * — une route qui répond mal, un écran qui en meurt — et les deux lignes côte à côte, à la même
 * minute, racontent ce qu'aucune ne dit seule. `scope: "client"` suffit à les séparer avec `jq`.
 *
 * Tout ici vient du navigateur, donc c'est lui qui déciderait de la place prise sur disque : les
 * chaînes sont coupées, et seuls les champs connus passent. `user` vient de la session, jamais du
 * corps de la requête.
 */
const CLIENT_FIELDS = ["source", "name", "url", "digest", "agent"] as const;

export function logClientError(user: string, report: Record<string, unknown>): void {
  const text = (value: unknown, max: number) => (typeof value === "string" && value ? value.slice(0, max) : undefined);
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: "error",
    scope: "client",
    user,
    message: text(report.message, 500) ?? "(sans message)",
  };
  for (const field of CLIENT_FIELDS) {
    const value = text(report[field], 300);
    if (value) entry[field] = value;
  }
  console.error(JSON.stringify(entry));
  const stack = text(report.stack, 4000);
  appendJsonLine(SERVER_LOG_FILE, {
    ...entry,
    // Même forme que la pile d'une erreur serveur : six lignes, sur une seule.
    stack: stack ? stack.split("\n").slice(0, 6).map((line) => line.trim()).join(" | ") : undefined,
  }, { keep: SERVER_LOG_KEEP });
}

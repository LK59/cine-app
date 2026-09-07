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
  });
}

/** Où il est, pour que la documentation et l'écran d'état le disent sans le deviner. */
export const SERVER_LOG_PATH = SERVER_LOG_FILE;

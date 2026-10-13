import { config } from "@/lib/config";
import { SERVICE_ENV, configuredServices, type ServiceKey } from "@/lib/services";

/**
 * Le côté serveur de `services.ts` : ce service est-il branché *maintenant* ? Relu à chaque appel
 * (les réglages se changent dans l'application sans redémarrer, DECISIONS.md §48).
 *
 * La règle qui en découle : **un service non configuré n'est jamais interrogé** — ni par un client,
 * ni par une tâche de fond, ni par un contrôle d'état. Une installation neuve sans qBittorrent
 * interrogeait l'adresse par défaut (`http://gluetun:8080`) toutes les quinze secondes pour le
 * suivi des torrents : une erreur dans `server.log` à chaque passage, et, si quelque chose
 * répondait à cette adresse, cinq connexions refusées suffisent à qBittorrent pour bannir l'adresse
 * du conteneur une heure (essai d'une installation neuve, 13/10/2026).
 */
export function serviceConfigured(key: ServiceKey): boolean {
  return configuredServices(config)[key];
}

/**
 * L'erreur d'un appel refusé avant tout réseau. Son message commence par « Non configuré », que
 * `classifyError` range en `missing_api_key` : jamais confondue avec une panne.
 */
export class ServiceNotConfiguredError extends Error {
  readonly service: ServiceKey;
  constructor(service: ServiceKey) {
    super(`Non configuré — ${SERVICE_ENV[service].join(", ")} (Configuration → Connexions, ou .env)`);
    this.name = "ServiceNotConfiguredError";
    this.service = service;
  }
}

/** Lève `ServiceNotConfiguredError` si le service n'est pas branché. */
export function assertServiceConfigured(key: ServiceKey): void {
  if (!serviceConfigured(key)) throw new ServiceNotConfiguredError(key);
}

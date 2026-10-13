/**
 * Ce qui est configuré, et ce qui ne l'est pas.
 *
 * Chaque intégration est facultative : une installation peut très bien n'avoir ni Bazarr, ni
 * Jackett, ni Jellyseerr. Jusqu'ici l'interface faisait comme si tout était là, et une page dont
 * le service n'existe pas se contentait d'échouer — un message d'erreur rouge qui ressemble à une
 * panne, là où il n'y a qu'une clé absente du fichier de configuration.
 *
 * Une seule liste, lue par le serveur pour dire ce qui est branché et par l'interface pour ne
 * proposer que ça. Aucun secret n'en sort : uniquement des booléens et le nom de ce qu'il faudrait
 * poser dans `.env` pour que ça marche.
 */
export type ServiceKey =
  | "radarr"
  | "sonarr"
  | "bazarr"
  | "jackett"
  | "jellyfin"
  | "jellyseerr"
  | "qbittorrent"
  | "tmdb";

/** Les variables d'environnement à poser, dans l'ordre où on les pose. */
export const SERVICE_ENV: Record<ServiceKey, string[]> = {
  radarr: ["RADARR_URL", "RADARR_API_KEY"],
  sonarr: ["SONARR_URL", "SONARR_API_KEY"],
  bazarr: ["BAZARR_URL", "BAZARR_API_KEY"],
  jackett: ["JACKETT_URL", "JACKETT_API_KEY"],
  jellyfin: ["JELLYFIN_URL", "JELLYFIN_API_KEY"],
  jellyseerr: ["JELLYSEERR_URL", "JELLYSEERR_API_KEY"],
  qbittorrent: ["QBITTORRENT_URL", "QBITTORRENT_PASSWORD"],
  tmdb: ["TMDB_API_KEY"],
};

export type ConfiguredServices = Record<ServiceKey, boolean>;

/**
 * L'adresse ne suffit pas : elle a une valeur par défaut pour la plupart des services, si bien
 * qu'elle est toujours renseignée. C'est le secret qui dit si quelqu'un a réellement branché
 * quelque chose. qBittorrent demande les deux : son adresse n'a plus de valeur par défaut depuis
 * le 13/10/2026 (`http://gluetun:8080`, l'adresse d'une installation particulière, était
 * interrogée par toutes les autres — voir `serviceConfigured.ts`).
 */
export function configuredServices(config: {
  radarr: { apiKey: string };
  sonarr: { apiKey: string };
  bazarr: { apiKey: string };
  jackett: { apiKey: string };
  jellyfin: { apiKey: string };
  jellyseerr: { apiKey: string };
  qbittorrent: { url: string; password: string };
  tmdb: { apiKey: string };
}): ConfiguredServices {
  return {
    radarr: !!config.radarr.apiKey,
    sonarr: !!config.sonarr.apiKey,
    bazarr: !!config.bazarr.apiKey,
    jackett: !!config.jackett.apiKey,
    jellyfin: !!config.jellyfin.apiKey,
    jellyseerr: !!config.jellyseerr.apiKey,
    qbittorrent: qbittorrentConfigured(config.qbittorrent),
    tmdb: !!config.tmdb.apiKey,
  };
}

/** qBittorrent n'a pas de clé : une adresse *et* un mot de passe, sans quoi il n'est jamais appelé. */
export function qbittorrentConfigured(qb: { url?: string; password?: string }): boolean {
  return !!qb.url?.trim() && !!qb.password;
}

/**
 * L'état d'un torrent qBittorrent, dit dans la langue de l'écran.
 *
 * La gestion affichait `state` brut, mis en capitales par CSS : « Downloading », « StalledDL »,
 * « PausedUP » au milieu d'une page française (18/11/2026). Les états sont ceux de l'API v2
 * (`/api/v2/torrents/info`, `stopped*` depuis qBittorrent 5) ; un état que la table ne connaît pas
 * — une version future — reste affiché tel quel plutôt que de disparaître.
 */
const KNOWN_STATES = new Set([
  "error",
  "missingFiles",
  "uploading",
  "pausedUP",
  "stoppedUP",
  "queuedUP",
  "stalledUP",
  "checkingUP",
  "forcedUP",
  "allocating",
  "downloading",
  "metaDL",
  "forcedMetaDL",
  "pausedDL",
  "stoppedDL",
  "queuedDL",
  "stalledDL",
  "checkingDL",
  "forcedDL",
  "checkingResumeData",
  "moving",
  "unknown",
]);

export function torrentStateLabel(state: string, t: (key: string) => string): string {
  return KNOWN_STATES.has(state) ? t(`qbittorrent.states.${state}`) : state;
}

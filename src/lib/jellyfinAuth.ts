/**
 * Comment on s'authentifie auprès de Jellyfin, et le seul endroit qui sache l'écrire.
 *
 * Tout ce dépôt envoyait `X-Emby-Token`. C'est l'un des quatre moyens hérités d'Emby — avec
 * `X-MediaBrowser-Token`, `X-Emby-Authorization` et le paramètre `api_key` en minuscules — et
 * Jellyfin les retire en trois temps : une option de configuration en 10.11, cette option passée
 * à `false` pour tout le monde en 12.0, la suppression du code en 13. Vérifié dans le source de
 * `v12.0-rc7` : `AuthorizationContext.GetAuthorizationInfoFromDictionary` ne lit `X-Emby-Token`
 * que derrière `EnableLegacyAuthorization`, et `ServerConfiguration.EnableLegacyAuthorization` n'a
 * plus d'initialiseur — donc `false`.
 *
 * Rien n'aurait prévenu : un en-tête ignoré n'est pas une erreur de migration, c'est un 401. Les
 * affiches, les chapitres, les vignettes de la barre, les sous-titres et le flux vidéo seraient
 * tous partis en même temps, le jour de la mise à jour du serveur.
 *
 * L'ancien en-tête n'est volontairement **pas** conservé à côté du nouveau. Les deux ensemble
 * marcheraient sur le 10.11 d'aujourd'hui même si le nouveau était mal formé — et on ne
 * l'apprendrait qu'en 12.0, c'est-à-dire trop tard. Envoyer le seul en-tête moderne fait de la
 * bibliothèque actuelle le banc d'essai de la migration.
 */

/**
 * De quel client vient la requête, quand cela regarde Jellyfin.
 *
 * Facultatif, et c'est vérifié dans le même fichier du serveur : `Client`, `Device`, `DeviceId` et
 * `Version` passent par `TryGetValue` et tolèrent d'être absents ; seul `Token` décide, et
 * `HasToken` est le seul rejet. Un en-tête réduit au jeton est donc complet.
 *
 * On ne l'ajoute que là où l'identité comptait déjà : Jellyfin range ses sessions et son historique
 * d'après ces champs, et en donner une à des appels qui n'en avaient pas — la clé
 * d'administration qui va chercher une affiche — ferait apparaître un appareil de plus dans le
 * tableau de bord pour un changement qui n'était censé toucher que la forme de l'authentification.
 */
export interface JellyfinIdentity {
  client: string;
  device: string;
  deviceId: string;
  version: string;
}

/**
 * La valeur de l'en-tête `Authorization`.
 *
 * Les valeurs sont entre guillemets parce que le serveur découpe sur les virgules et les
 * guillemets, puis passe chaque valeur à `WebUtility.UrlDecode`. Les jetons et les clés d'API de
 * Jellyfin sont hexadécimaux, donc rien à échapper en pratique — mais c'est la raison pour
 * laquelle cette écriture vit à un seul endroit plutôt que d'être recopiée à douze.
 */
export function jellyfinAuth(token: string, identity?: JellyfinIdentity): string {
  if (!identity) return `MediaBrowser Token="${token}"`;
  return (
    `MediaBrowser Client="${identity.client}", Device="${identity.device}", ` +
    `DeviceId="${identity.deviceId}", Version="${identity.version}", Token="${token}"`
  );
}

/** L'en-tête complet, pour les appels qui n'en ont pas d'autre à poser. */
export function jellyfinAuthHeaders(token: string, identity?: JellyfinIdentity): { Authorization: string } {
  return { Authorization: jellyfinAuth(token, identity) };
}

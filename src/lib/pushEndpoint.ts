/**
 * Un abonnement push n'est accepté que vers un service de notifications connu.
 *
 * `POST /api/push/subscribe` enregistrait n'importe quelle URL, et le serveur y fait ensuite un
 * POST — à chaque notification, et à la demande avec `/api/push/test`, qui renvoyait en plus le
 * corps de la réponse au navigateur. Un compte pouvait donc faire interroger par le serveur une
 * adresse de son réseau interne (Radarr, Jellyfin, la passerelle…) et en lire la réponse ; et
 * `web-push` accumule cette réponse sans borne (26/09/2026).
 *
 * Les navigateurs, eux, ne rendent que des adresses de leur service : Apple pour Safari et tout
 * ce qui tourne sur iOS, Google (FCM) pour Chrome, Edge sous Android, Opera, Brave, Samsung ;
 * Mozilla pour Firefox ; Microsoft (WNS) pour Edge sous Windows. Les trois abonnements en base le
 * 26/09/2026 sont tous chez Apple.
 */
const EXACT_HOSTS = new Set([
  "web.push.apple.com",
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com",
]);
const HOST_SUFFIXES = [".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com"];

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // HTTPS sur le port par défaut, sans identifiants : rien qui détourne la connexion ailleurs.
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Au plus tant d'appareils abonnés par compte ; au-delà, les plus anciens sont retirés. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;

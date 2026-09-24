// Révoquer chez Jellyfin le jeton qu'une connexion à l'application avait obtenu.
//
// Chaque connexion demande à Jellyfin un jeton, sous un appareil à elle (`cine-app-<aléatoire>`).
// Rien ne le révoquait jamais : la déconnexion ne fermait que la session de l'application, et les
// jetons s'accumulaient — vingt-quatre appareils « CineApp » pour un seul compte au 24/09/2026,
// autant de jetons valides pour toujours. Désormais :
//  - « Se déconnecter » ferme la session de l'application et révoque son jeton ;
//  - « Déconnecter tous les autres » ne ferme que les sessions de l'application — choix de
//    l'administrateur, rien n'y touche Jellyfin ;
//  - une session fermée par l'administrateur, ou effacée parce qu'expirée, révoque le sien : c'est
//    une déconnexion complète, et plus personne ne s'en servira.
// Seul l'appareil de la connexion tombe : la télévision, Jellyfin web, les applications mobiles
// ont leurs propres jetons et n'en savent rien.
//
// Toujours au mieux : un Jellyfin absent ne doit jamais empêcher quelqu'un de se déconnecter.

import { jellyfin } from "@/lib/clients/jellyfin";
import { logError } from "@/lib/logger";

/** Supprime ces appareils chez Jellyfin. Ne lève jamais. */
export async function revokeJellyfinDevices(devices: (string | null | undefined)[] | null | undefined, why: string): Promise<void> {
  for (const device of devices ?? []) {
    // Seulement ce que l'application a elle-même inscrit : un identifiant venu d'ailleurs ne doit
    // jamais faire tomber l'appareil de quelqu'un d'autre.
    if (!device || !device.startsWith("cine-app-")) continue;
    try {
      await jellyfin.deleteDevice(device);
    } catch (error) {
      logError("jellyfin-revoke", error, { where: why, device });
    }
  }
}

/** Ferme la session d'un jeton, pour une session ouverte avant qu'on garde son appareil. Ne lève jamais. */
export async function revokeJellyfinToken(token: string | null | undefined, why: string): Promise<void> {
  if (!token) return;
  try {
    await jellyfin.logoutToken(token);
  } catch (error) {
    logError("jellyfin-revoke", error, { where: why });
  }
}

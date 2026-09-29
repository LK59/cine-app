// Sous quel appareil un rapport de lecture s'annonce à Jellyfin.
//
// Chaque appareil réel apparaissait deux fois dans le tableau de bord de Jellyfin : la connexion
// inscrivait `cine-app-<aléatoire>` sous le nom « Server », et les rapports de lecture
// s'annonçaient sous un autre identifiant (`cine-app-<compte>` / `cine-engine-<compte>`) nommé
// « Navigateur » — un appareil fantôme partagé par tous les navigateurs d'un même compte
// (29/09/2026). Désormais les rapports reprennent l'appareil de la connexion, gardé avec la
// session, et le libellé de l'appareil qui les envoie.
//
// Pourquoi c'est sans danger — vérifié dans le source de Jellyfin v12.1 :
//  - un rapport de lecture n'authentifie pas. `AuthorizationContext` retrouve l'appareil par le
//    *jeton* ; le `DeviceId` de l'en-tête ne réécrit rien (seuls le nom et la version de
//    l'appareil sont mis à jour). L'éviction qui avait motivé des identifiants séparés vit dans
//    `SessionManager.GetAuthorizationToken`, appelé seulement par `AuthenticateByName`, jamais ici ;
//  - une session Jellyfin est clé par `Client + DeviceId + UserId` (`GetSessionKey`) : le lecteur
//    serveur (« CineApp ») et le lecteur natif (« CineEngine By CineApp ») restent deux sessions
//    distinctes sous le même appareil.
//
// Une session ouverte avant qu'on garde son appareil n'en a pas : elle garde l'ancien identifiant
// par compte (`playbackHeaders`), comme avant.

import { sessionDb } from "@/lib/db";
import { jellyfinDeviceName, requestDeviceLabel } from "@/lib/deviceLabel";

export interface PlaybackDevice {
  /** Le champ `Device` : « iPad · Safari », ou « Navigateur » faute de mieux. */
  name: string;
  /** L'appareil inscrit à la connexion, ou `null` s'il n'est pas connu. */
  id: string | null;
}

/** L'appareil d'un rapport de lecture : son libellé, et l'appareil Jellyfin de la session `jti`. */
export function playbackDevice(req: { headers: { get(name: string): string | null } }, jti: string | undefined): PlaybackDevice {
  let id: string | null = null;
  // Une lecture de la base qui échoue ne doit pas coûter le rapport : l'ancien identifiant suffit.
  try {
    id = jti ? sessionDb.jfDevice(jti) : null;
  } catch {
    id = null;
  }
  // Seulement ce que la connexion a elle-même inscrit — même garde que `revokeJellyfinDevices`.
  if (id && !id.startsWith("cine-app-")) id = null;
  return { name: jellyfinDeviceName(requestDeviceLabel(req)), id };
}

import type { PublicRoomView, RoomView } from "../../../salons/src/protocol";
import type { Look } from "../../../salons/src/tv";

/**
 * L'état des salons dans le store (`state/store.ts`) — à part de `salons.ts`, sans rien importer d'autre : le
 * store le lit à sa création, et le module réseau lit le store ; dans un seul fichier, cela ferait une boucle
 * d'imports dont l'ordre de chargement déciderait si la page démarre.
 */
export type NetStatus = "off" | "checking" | "unavailable" | "connecting" | "online" | "reconnecting";

export type PublicRoom = PublicRoomView;

export interface NetState {
  status: NetStatus;
  you: { id: string; name: string } | null;
  room: RoomView | null;
  publicRooms: PublicRoom[];
  /** La dernière erreur à montrer (un code inconnu, un salon complet), ou rien. */
  error: string | null;
  /** Heure du service − heure du navigateur, en millisecondes (mesurée au plus court aller-retour). */
  offset: number;
  /** Ce plus court aller-retour, en millisecondes. */
  rtt: number;
  /** Les derniers messages du chat du salon (les plus récents à la fin), gardés le temps du salon. */
  chat: ChatLine[];
  /** Notre apparence (`world/avatarLook.ts`), lue du compte à la connexion ; `null` tant qu'elle n'est pas connue. */
  look: Look | null;
}

export interface ChatLine {
  id: string;
  name: string;
  text: string;
  /** Heure locale de réception (pour l'effacement), en millisecondes. */
  at: number;
}

export const IDLE_NET: NetState = { status: "off", you: null, room: null, publicRooms: [], error: null, offset: 0, rtt: 0, chat: [], look: null };

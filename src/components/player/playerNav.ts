"use client";

import { Home, Search, Bookmark, User, SlidersHorizontal } from "lucide-react";
import { cinemaNavigate, type CinemaRoute } from "@/lib/cinemaRoute";

export type PlayerPanel = "home" | "search" | "list" | "account";

export interface PlayerNavItem {
  panel: PlayerPanel;
  labelKey: string;
  icon: React.ElementType;
}

/**
 * Le rail, et le tiroir du téléphone, lisent cette liste — une seule description pour les deux,
 * comme NAV_GROUPS le fait déjà côté gestion.
 *
 * Quatre entrées, et c'est un plafond, pas un hasard : au-delà, le rail cesse d'être un repère et
 * redevient une liste dans laquelle on cherche. Tout le reste du parcours (les fiches, les
 * épisodes, les acteurs) s'ouvre depuis le contenu, pas depuis la navigation.
 */
export const PLAYER_NAV: PlayerNavItem[] = [
  { panel: "home", labelKey: "player.nav.home", icon: Home },
  { panel: "search", labelKey: "player.nav.search", icon: Search },
  { panel: "list", labelKey: "player.nav.myList", icon: Bookmark },
  { panel: "account", labelKey: "player.nav.account", icon: User },
];

/** L'entrée du bas, à part : elle quitte le lecteur au lieu d'ouvrir un panneau. */
export const MANAGE_ITEM = { href: "/gestion", labelKey: "player.nav.manage", icon: SlidersHorizontal };

/** Quel panneau la route décrit — « home » quand aucun n'est ouvert. */
export function activePanel(route: CinemaRoute): PlayerPanel {
  if (route.search) return "search";
  if (route.list) return "list";
  if (route.account) return "account";
  return "home";
}

/**
 * Ouvrir un panneau depuis le rail.
 *
 * Les panneaux s'excluent : ouvrir « Ma liste » alors que la recherche est ouverte doit remplacer
 * l'écran, pas l'empiler. D'où le patch complet plutôt qu'un seul champ — sans ça, revenir en
 * arrière rouvrirait un panneau qu'on croyait fermé.
 *
 * « Accueil » revient à la grille : il referme aussi la fiche ouverte, sinon on retomberait
 * dessus. C'est un `replace` quand on y est déjà, pour qu'un clic répété n'empile pas d'entrées
 * dans l'historique.
 */
export function openPanel(panel: PlayerPanel, current: CinemaRoute): void {
  const closed = {
    search: false,
    list: false,
    account: false,
    film: null,
    serie: null,
    episodes: false,
    discover: null,
    person: null,
    browse: null,
    // Le tiroir du téléphone se referme dans le *même* mouvement.
    //
    // Il se fermait juste avant, par un `cinemaClose` séparé — donc un `history.back()`, qui est
    // asynchrone : la navigation suivante était empilée avant que le retour ait eu lieu, et le
    // retour l'annulait ensuite. On choisissait « Ma liste » et on retombait sur la grille.
    menu: false,
  } satisfies Partial<CinemaRoute>;

  if (panel === "home") {
    const alreadyHome =
      activePanel(current) === "home" &&
      !current.film &&
      !current.serie &&
      !current.discover &&
      !current.person &&
      !current.browse;
    cinemaNavigate(closed, alreadyHome ? "replace" : "push");
    return;
  }
  // Sur le panneau demandé, et rien par-dessus : il n'y a rien à faire, et empiler une entrée
  // d'historique pour un clic sans effet ferait qu'un retour ne semblerait rien faire non plus.
  //
  // Mais si une fiche le recouvre, le même clic doit la refermer et redescendre sur le panneau —
  // c'est ce qu'on attend d'un rail : y retourner. Sans cette nuance, le clic ne faisait rien.
  const covered =
    current.film !== null ||
    current.serie !== null ||
    current.discover !== null ||
    current.person !== null ||
    current.browse !== null;
  if (activePanel(current) === panel && !covered) return;

  // Depuis le tiroir du téléphone, on remplace au lieu d'empiler : le tiroir est une étape vers
  // un écran, pas un écran en soi. Sans ça, un retour depuis « Ma liste » rouvrait le tiroir, et
  // il fallait appuyer deux fois pour revenir à l'accueil.
  cinemaNavigate(
    { ...closed, ...(panel === "search" ? { search: true } : panel === "list" ? { list: true } : { account: true }) },
    current.menu ? "replace" : "push"
  );
}

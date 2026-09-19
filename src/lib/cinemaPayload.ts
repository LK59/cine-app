/**
 * La charge utile du catalogue, telle qu'elle voyage et telle qu'elle se lit.
 *
 * Elle partait avec **chaque titre répété une fois par genre** — un film à trois genres était
 * sérialisé trois fois en entier, synopsis compris. Mesuré sur cette bibliothèque : 689 films
 * devenaient 1730 entrées, soit un facteur 2,51, et les seuls synopsis passaient de 178 Ko à
 * 448 Ko. C'est la ressource bloquante de l'écran d'accueil, celle qu'on attend au fond du jardin
 * en 5G.
 *
 * Le remède tient en une indirection : les titres une fois dans `items`, et partout ailleurs leur
 * identifiant. Ce qui arrive sur le réseau maigrit d'environ 60 %.
 *
 * **Et rien d'autre ne change.** `hydrate` reconstruit à l'arrivée exactement la forme que les
 * écrans connaissent — les mêmes objets, partagés par référence, donc sans un octet de mémoire en
 * plus. Une vingtaine d'endroits lisent ces listes ; les réécrire tous pour gagner des octets
 * aurait été le meilleur moyen d'introduire un défaut dans ce qui marche.
 */

import { noteUnauthorized } from "@/lib/sessionExpired";
import { withCode } from "@/lib/upstreamError";

/** Ce qui voyage : les titres une fois, et des identifiants partout ailleurs. */
export interface WirePayload<T> {
  genres: string[];
  /** Chaque titre une seule fois. Absent d'une charge utile d'avant ce changement. */
  items?: T[];
  rows: Record<string, number[] | T[]>;
  spotlight: number[] | T[];
  recentlyAdded: number[] | T[];
  top10: number[] | T[];
}

/** Ce qui se lit : des titres, partout, comme avant. */
export interface HydratedPayload<T> {
  genres: string[];
  rows: Record<string, T[]>;
  spotlight: T[];
  recentlyAdded: T[];
  top10: T[];
}

function isIdList(list: unknown[]): list is number[] {
  return list.length > 0 && typeof list[0] === "number";
}

/**
 * Rend à la charge utile la forme que les écrans attendent.
 *
 * Tolérante aux deux formes, et ce n'est pas de la prudence gratuite : le service worker peut
 * resservir une charge utile enregistrée avant ce changement, et un écran ouvert pendant un
 * déploiement en reçoit une neuve avec du code ancien. Une liste déjà pleine d'objets est donc
 * rendue telle quelle.
 *
 * Un identifiant que `items` ne connaît pas est simplement omis : mieux vaut une rangée plus
 * courte qu'un trou dans la grille.
 */
export function hydrate<T>(payload: WirePayload<T> | undefined, idOf: (item: T) => number): HydratedPayload<T> | undefined {
  if (!payload) return undefined;
  const byId = new Map((payload.items ?? []).map((item) => [idOf(item), item]));
  const resolve = (list: number[] | T[]): T[] =>
    isIdList(list) ? list.map((id) => byId.get(id)).filter((item): item is T => item !== undefined) : (list as T[]);

  return {
    genres: payload.genres,
    rows: Object.fromEntries(Object.entries(payload.rows).map(([genre, list]) => [genre, resolve(list)])),
    spotlight: resolve(payload.spotlight),
    recentlyAdded: resolve(payload.recentlyAdded),
    top10: resolve(payload.top10),
  };
}

/**
 * Le récupérateur du catalogue : il va chercher, puis rend la forme complète.
 *
 * Posé ici plutôt que chez les sept écrans qui lisent ce catalogue : un seul endroit sait que la
 * charge utile voyage dédupliquée, et aucun de ces sept n'a eu à changer d'une ligne. Le champ
 * d'identifiant se déduit de l'adresse, qui dit déjà s'il s'agit de films ou de séries.
 */
export async function cinemaFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    noteUnauthorized(res);
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw withCode(new Error(body.error || `Erreur ${res.status}`), body.code);
  }
  const raw = (await res.json()) as WirePayload<Record<string, unknown>> & Record<string, unknown>;
  const idOf = url.includes("/series")
    ? (item: Record<string, unknown>) => item.sonarrId as number
    : (item: Record<string, unknown>) => item.radarrId as number;
  // `top10Theme` et tout ce que la route ajoutera un jour traversent sans être touchés : seules
  // les quatre listes connues sont reconstruites.
  return { ...raw, ...hydrate(raw, idOf) } as T;
}


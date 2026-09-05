/**
 * L'état d'une demande, tel qu'il se dit à quelqu'un qui ne connaît ni Jellyseerr ni Radarr.
 *
 * Jellyseerr tient deux énumérations distinctes, et aucune ne se lit telle quelle :
 *
 *   - la demande : 1 en attente, 2 acceptée, 3 refusée, 4 échouée, 5 terminée ;
 *   - le média   : 1 inconnu, 2 en attente, 3 en traitement, 4 partiellement disponible,
 *                  5 disponible.
 *
 * Comme la validation est automatique ici, « en attente d'acceptation » n'existe jamais : une
 * demande passe en traitement dans la seconde. Il ne reste donc que trois choses vraies à dire —
 * plus le cas où ça n'a pas abouti, qui ne devrait pas arriver mais qu'on ne va pas afficher
 * comme un chargement éternel.
 *
 * « Pas encore sorti » ne vient d'aucune des deux énumérations : il se déduit de la date de
 * sortie. Sans lui, un film demandé six mois avant sa sortie reste « en cours » tout ce temps,
 * ce qui ressemble à une panne alors que tout va bien.
 */
export type PlayerRequestState = "unreleased" | "processing" | "available" | "removed" | "failed";

/** Jellyseerr — statut de la demande. */
const REQUEST_DECLINED = 3;
const REQUEST_FAILED = 4;
/** Jellyseerr — statut du média. */
const MEDIA_PARTIALLY_AVAILABLE = 4;
const MEDIA_AVAILABLE = 5;
/**
 * 6 « sur liste noire », 7 « supprimé ».
 *
 * Le second est le cas qu'on rencontre pour de vrai : le titre est arrivé, puis a été retiré de
 * la bibliothèque. Aucune des deux énumérations ne le disait, alors que la demande, elle, reste
 * marquée « terminée » — trois vieilles demandes affichaient donc « En cours » depuis des mois
 * pour des films qui ne sont plus là. Vérifié en direct : `media.status: 7`, et les trois titres
 * absents de Radarr.
 */
const MEDIA_BLACKLISTED = 6;
const MEDIA_DELETED = 7;

export interface RequestStateInput {
  requestStatus?: number | null;
  mediaStatus?: number | null;
  /**
   * `true`/`false` quand on sait, `null` quand on n'a pas l'information.
   *
   * La distinction compte : une date absente de TMDB veut dire « pas encore annoncé », donc pas
   * encore sorti ; mais une *source* qui ne porte pas le champ du tout ne dit rien, et traiter
   * les deux pareil ferait afficher « pas encore sorti » sur toute la bibliothèque le jour où un
   * appel change de forme. Dans le doute, on préfère « en cours ».
   */
  released?: boolean | null;
}

export function resolveRequestState(input: RequestStateInput): PlayerRequestState {
  // Disponible l'emporte sur tout le reste : si le fichier est là, peu importe par quel chemin il
  // est arrivé, ni ce que dit encore la demande.
  if (input.mediaStatus === MEDIA_AVAILABLE || input.mediaStatus === MEDIA_PARTIALLY_AVAILABLE) {
    return "available";
  }
  if (input.mediaStatus === MEDIA_DELETED || input.mediaStatus === MEDIA_BLACKLISTED) {
    return "removed";
  }
  if (input.requestStatus === REQUEST_DECLINED || input.requestStatus === REQUEST_FAILED) {
    return "failed";
  }
  if (input.released === false) return "unreleased";
  return "processing";
}

/**
 * Une date absente compte comme « pas encore sortie » : TMDB et Jellyseerr laissent le champ vide
 * tant qu'aucune date n'est annoncée, ce qui ne concerne que des titres à venir. Une date
 * illisible, elle, ne doit rien bloquer — on la considère sortie.
 */
export function isReleased(releaseDate: string | null | undefined, now = new Date()): boolean {
  if (!releaseDate) return false;
  const time = Date.parse(releaseDate);
  if (Number.isNaN(time)) return true;
  return time <= now.getTime();
}

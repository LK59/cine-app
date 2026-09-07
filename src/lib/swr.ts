import { mutate as globalMutate } from "swr";
import { noteUnauthorized } from "@/lib/sessionExpired";
import { isWatchingFullScreen } from "@/lib/playbackBusy";

export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    noteUnauthorized(res);
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur ${res.status}`);
  }
  return res.json();
};

/**
 * Les deux flux qui vieillissent pendant qu'on regarde ailleurs.
 *
 * Tout le reste du catalogue est figé volontairement — il ne change qu'au rythme des imports, et
 * le recharger au retour coûterait 1,4 Mo pour rien. Ces deux-là sont l'exception : la position
 * d'un film et l'épisode qui attend sont exactement ce qui a bougé pendant que le téléphone
 * dormait, ou pendant qu'on regardait la même série sur la télé.
 */
export const RESUME_KEY = "/api/jellyfin/resume";
export const NEXT_UP_KEY = "/api/cinema/next-up";

/**
 * De quoi rouvrir l'application sur des données vraies.
 *
 * `revalidateOnFocus` écoute `visibilitychange` autant que `focus` : c'est ce qui fait la
 * différence entre revenir d'une veille et revenir d'un autre onglet. L'intervalle empêche un
 * va-et-vient entre deux applications de déclencher une requête par aller-retour.
 */
export const liveFeedOptions = {
  revalidateOnFocus: true,
  focusThrottleInterval: 30_000,
} as const;

/**
 * Ce dont le lecteur a besoin pour exister — que le lecteur ne doit jamais mettre en pause.
 *
 * `SWRProvider` suspend toute requête tant qu'un film occupe l'écran entier : la page derrière lui
 * est invisible, ses sondages ne seraient que des réveils de radio disputant la bande passante au
 * film. L'intention est juste, et elle vise des *sondages*.
 *
 * Elle attrapait aussi les deux requêtes sans lesquelles le lecteur ne peut pas s'afficher, ce qui
 * se referme sur soi-même. Observé, et c'est un blocage complet : après le rechargement de page
 * que WebKit impose pour changer de piste audio, la séance est rouverte dès le montage, l'écran
 * entier est déclaré occupé — et la préférence « ancien lecteur » ne peut plus être lue. Or
 * PlayerHost ne rend rien tant qu'il ne la connaît pas. Plus rien ne s'affiche, plus rien ne peut
 * lever la pause, et toute l'application reste sans données : plus de bouton Lire, une recherche
 * qui ne rend rien. Seul un rechargement à la main s'en sortait, et par accident — l'intention de
 * reprise n'étant lue qu'une fois, la fois suivante il n'y avait plus de séance à rouvrir.
 *
 * Un sondage attend son tour. Ce qui conditionne l'affichage, non.
 */
export const playerBootstrapOptions = { isPaused: () => false } as const;


/**
 * Les deux catalogues, nommés une fois.
 *
 * Onze endroits écrivaient ces deux adresses à la main, et ce sont des clés de cache autant que
 * des URL : deux écritures qui divergent d'un caractère, ce sont deux caches qui s'ignorent, donc
 * un catalogue téléchargé deux fois sans que rien ne le signale.
 */
export const MOVIES_CATALOGUE_KEY = "/api/cinema/movies";
export const SERIES_CATALOGUE_KEY = "/api/cinema/series";

/** La clé qui porte « vu », « favori » et le point de reprise d'un titre. */
export const progressKey = (itemId: string) => `/api/cinema/progress/${itemId}`;

/**
 * Combien de temps attendre que l'écran se libère avant d'abandonner la remise en cause.
 *
 * L'animation de fermeture dure 200 ms ; le reste est de la marge pour que React ait rendu et que
 * `setWatchingFullScreen(false)` soit passé. Borné, parce qu'une attente sans fin sur un lecteur
 * qui ne se ferme pas serait une fuite silencieuse.
 */
const UNPAUSE_TIMEOUT_MS = 3000;
const UNPAUSE_POLL_MS = 50;

function whenScreenIsFree(): Promise<boolean> {
  if (!isWatchingFullScreen()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!isWatchingFullScreen()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > UNPAUSE_TIMEOUT_MS) {
        clearInterval(timer);
        resolve(false);
      }
    }, UNPAUSE_POLL_MS);
  });
}

/**
 * Ce que la fermeture du lecteur vient de rendre faux, relu — pour les deux lecteurs.
 *
 * Quitter un film à trente minutes laissait sa fiche sur « Lecture » et la rangée « Reprendre »
 * de l'accueil inchangée, jusqu'à ce qu'on quitte l'écran et qu'on y revienne. Rien ne relisait :
 * `PlaybackProvider` ne redemande que les clés restées *sans* donnée ni erreur, et celles-ci en
 * avaient une — simplement périmée depuis la première seconde du film.
 *
 * Deux attentes, et aucune n'est superflue :
 *
 * 1. **Le rapport d'arrêt.** Relire la position avant que Jellyfin l'ait enregistrée redonne
 *    exactement la valeur qu'on voulait remplacer, et la fiche resterait fausse — avec, en prime,
 *    la conviction d'avoir rafraîchi.
 * 2. **L'écran libéré.** SWR est en pause tant qu'un film l'occupe entièrement, et une requête
 *    mise en pause est *abandonnée*, pas différée. Demander la relecture pendant l'animation de
 *    fermeture, c'est la jeter.
 */
/**
 * Tout ce qui décrit « où en est ce titre », relu d'un coup.
 *
 * Quatre vues portent cette même information et se démentaient l'une l'autre : la rangée des
 * reprises, l'épisode qui attend, la progression du titre, et la liste d'épisodes de sa série.
 *
 * Deux gestes la changent, et il n'y en a pas d'autres : finir de regarder, et cocher « vu » à la
 * main. Le premier les relisait déjà toutes ; le second ne relisait que sa propre fiche et « Ma
 * liste », si bien que marquer un film comme vu le laissait dans « Reprendre » sur l'accueil
 * jusqu'au rechargement suivant. Une seule liste de clés pour les deux, donc, plutôt que deux
 * listes qui divergeront.
 */
export async function revalidateWatchState(itemId: string | null): Promise<void> {
  const keys = itemId ? [RESUME_KEY, NEXT_UP_KEY, progressKey(itemId)] : [RESUME_KEY, NEXT_UP_KEY];
  await Promise.all([
    ...keys.map((key) => globalMutate(key)),
    /**
     * Et la liste d'épisodes de la série, qui porte la position de chacun et celui qu'il faut
     * reprendre. Un filtre plutôt qu'un nom : cette clé est bâtie sur l'identifiant de la *série*,
     * et l'appelant ne connaît que celui de l'épisode.
     *
     * La barre oblique finale compte : `/api/cinema/series` sans elle est le catalogue entier,
     * 1,4 Mo qu'on ne veut surtout pas redemander pour une case cochée.
     */
    globalMutate((key) => typeof key === "string" && key.startsWith("/api/cinema/series/")),
  ]);
}

/**
 * Ce que la fermeture du lecteur vient de rendre faux, relu — pour les deux lecteurs.
 *
 * Deux attentes, et aucune n'est superflue :
 *
 * 1. **Le rapport d'arrêt.** Relire la position avant que Jellyfin l'ait enregistrée redonne
 *    exactement la valeur qu'on voulait remplacer, et la fiche resterait fausse — avec, en prime,
 *    la conviction d'avoir rafraîchi.
 * 2. **L'écran libéré.** SWR est en pause tant qu'un film l'occupe entièrement, et une requête
 *    mise en pause est *abandonnée*, pas différée. Demander la relecture pendant l'animation de
 *    fermeture, c'est la jeter.
 *
 * La bascule « vu » n'a besoin ni de l'une ni de l'autre : rien n'a été rapporté, et l'écran est
 * déjà là. Elle appelle donc `revalidateWatchState` directement.
 */
export async function refreshAfterPlayback(reported: Promise<void>, itemId: string | null): Promise<void> {
  await reported;
  if (!(await whenScreenIsFree())) return;
  await revalidateWatchState(itemId);
}

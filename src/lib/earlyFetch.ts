import { MOVIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";

/**
 * Les requêtes de l'ouverture, parties avec le HTML et reprises par l'écran (15/10/2026).
 *
 * L'accueil est en `ssr: false` : sans rien, la chaîne est en file — HTML, JS de la coquille, morceau
 * de l'écran cinéma, puis seulement les requêtes. Une amorce `<link rel="preload">` couvrait la
 * fenêtre pour le catalogue, mais Safari ne la reprend qu'une fois sur deux : coupée sur WebKit le
 * 08/10/2026 (300 Ko téléchargés deux fois), et depuis, sur iPhone, la requête partait une seconde
 * après le démarrage du code — mesuré au journal d'ouverture (`routes`, 15/10) : code prêt à 0,78 s,
 * catalogue parti à 1,76 s, revenu 0,28 s plus tard (serveur 0,05 s).
 *
 * Ici, c'est notre code qui fait le lien, pas le navigateur : un script en ligne du layout lance les
 * trois `fetch` nus — exactement ceux des récupérateurs (`fetcher`, `cinemaFetcher`), même mode, mêmes
 * identifiants — et range les promesses ; le récupérateur prend la sienne une fois (`takeEarlyResponse`)
 * au lieu de redemander. Une seule requête par adresse, sur tous les moteurs.
 *
 * Ce fichier n'importe rien de client : le layout (composant serveur) le lit. `swr.ts` ne peut pas
 * l'être (voir `catalogueKeys.ts`) — d'où les adresses écrites ici, comparées par un test.
 */

/** Les flux que l'écran demande à chaque ouverture, quel que soit l'onglet. */
export const EARLY_FETCH_URLS: readonly string[] = [MOVIES_CATALOGUE_KEY, "/api/jellyfin/resume", "/api/cinema/next-up"];

/**
 * Au-delà, la réponse rangée n'est plus prise : ce n'est plus une ouverture. L'écran la demande
 * normalement à son montage, une à deux secondes après le HTML.
 */
export const EARLY_FETCH_MAX_AGE_MS = 20_000;

/**
 * La clé de `sessionStorage` d'un rechargement qui rouvre un film (`PLAYER_RELOAD_INTENT_KEY`,
 * PlaybackProvider — composant client, d'où la copie, comparée par un test). Une page rechargée pour
 * rouvrir le lecteur serveur ne demande rien : SWR est en pause pendant un film en plein écran, et
 * 300 Ko de catalogue passeraient pendant que le film redémarre.
 */
const RELOAD_INTENT_KEY = "cine:player-reload-intent";

interface EarlyEntry {
  at: number;
  p: Promise<Response>;
}

type EarlyStore = Record<string, EarlyEntry | undefined>;

declare global {
  interface Window {
    __cineEarly?: EarlyStore;
  }
}

/**
 * Le script en ligne : ES5, sans dépendance, et qui ne lève jamais — une erreur ici ne doit coûter
 * que la requête anticipée, l'écran la refait. `p.catch` évite une promesse rejetée sans preneur
 * (réseau coupé à l'ouverture) ; celui qui la prend reçoit toujours le rejet.
 */
export function earlyFetchScript(): string {
  const urls = JSON.stringify(EARLY_FETCH_URLS);
  const intent = JSON.stringify(RELOAD_INTENT_KEY);
  return (
    "(function(){try{if(window.__cineEarly)return;" +
    `try{if(sessionStorage.getItem(${intent})!==null)return}catch(e){}` +
    "var s={};" +
    `${urls}.forEach(function(u){var p=fetch(u);p.catch(function(){});s[u]={at:performance.now(),p:p}});` +
    "window.__cineEarly=s}catch(e){}})();"
  );
}

/**
 * La réponse anticipée de cette adresse, une seule fois, si elle a moins de `EARLY_FETCH_MAX_AGE_MS`.
 * `null` : rien de rangé, déjà pris, ou trop vieux — le récupérateur fait son `fetch` comme avant.
 */
export function takeEarlyResponse(url: string): Promise<Response> | null {
  if (typeof window === "undefined") return null;
  const store = window.__cineEarly;
  const entry = store?.[url];
  if (!store || !entry) return null;
  store[url] = undefined;
  let age = Infinity;
  try {
    age = performance.now() - entry.at;
  } catch {
    /* sans horloge, on ne la prend pas */
  }
  return age >= 0 && age <= EARLY_FETCH_MAX_AGE_MS ? entry.p : null;
}

/**
 * Le `fetch` d'un récupérateur : la réponse anticipée si elle est là, sinon la requête d'avant. Une
 * anticipée qui a échoué (réseau coupé pendant le chargement) est refaite, comme si elle n'avait pas
 * existé.
 */
export function fetchOrEarly(url: string): Promise<Response> {
  const early = takeEarlyResponse(url);
  return early ? early.catch(() => fetch(url)) : fetch(url);
}

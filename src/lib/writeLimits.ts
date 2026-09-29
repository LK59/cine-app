import { createRateLimiter } from "@/lib/rateLimiter";

/**
 * La limite de débit, par compte, des écritures ouvertes à tous les comptes connectés (D12,
 * 29/09/2026).
 *
 * Ces routes ne font qu'ajouter — au journal du lecteur, à celui du serveur, à celui des
 * ouvertures, au fil d'un signalement —, et c'est ce qui les rendait dangereuses : un client qui
 * boucle (un onglet pris dans une erreur, un script) faisait tourner les 600 Mo de `player.log` en
 * quelques minutes, et la rotation effaçait la soirée des autres spectateurs. C'est la panne du
 * banc d'essai, par une autre voie.
 *
 * Les seuils sont très au-dessus de l'usage : ils ne doivent arrêter qu'une boucle. Par compte
 * (l'identifiant de la session, jamais le corps) et non par adresse : une maison entière sort par
 * la même adresse, et c'est un compte qui boucle, pas une adresse. Au-delà : 429, et les clients
 * n'insistent pas — `reportPlayback`, `reportClientError` et `persistentCache` envoient sans
 * relire la réponse, et `unsentStop` garde son bilan pour le lancement suivant.
 */
export const WRITE_LIMITS = {
  /**
   * Le lecteur : un `reserve point` toutes les 30 s, plus des rafales d'évènements — un saut, une
   * reconstruction, un changement de piste, un arrêt — et les bilans `lost` au lancement. Une
   * séance chargée écrit une dizaine de lignes par minute ; deux onglets ou deux appareils du
   * même compte, le double. 120 laisse une marge de six.
   *
   * Le banc d'essai d'un administrateur (lignes `bench`) en est exempté : il enchaîne les films et
   * écrit bien plus vite, dans son propre journal.
   */
  playerLog: { max: 120, windowMs: 60_000 },
  /** `reportClientError` ne signale que 20 erreurs distinctes par page ; 30 couvre un rechargement. */
  clientError: { max: 30, windowMs: 60_000 },
  /** Une mesure par ouverture du cinéma : dix ouvertures en une minute, c'est déjà une boucle. */
  startupTiming: { max: 10, windowMs: 60_000 },
  /** Un commentaire se tape à la main : vingt en une minute n'en est plus un. */
  reportMessages: { max: 20, windowMs: 60_000 },
} as const;

const limiter = (name: keyof typeof WRITE_LIMITS) => createRateLimiter(WRITE_LIMITS[name].max, WRITE_LIMITS[name].windowMs);

/** Vrai tant que ce compte reste sous le seuil ; chaque appel compte une écriture. */
export const playerLogAllowed = limiter("playerLog");
export const clientErrorAllowed = limiter("clientError");
export const startupTimingAllowed = limiter("startupTiming");
export const reportMessageAllowed = limiter("reportMessages");

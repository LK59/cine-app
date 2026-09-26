/**
 * Là où TMDB sert ses images — une constante sans dépendance, lisible par le navigateur.
 *
 * Elle vivait dans `clients/tmdb.ts`, qui importe `config` : cinq écrans l'important pour cette
 * seule chaîne embarquaient toute la configuration du serveur dans le JavaScript servi — aucune
 * clé (le navigateur n'a pas `process.env`), mais les noms d'hôtes internes de chaque service et
 * les valeurs par défaut (audit du 26/09/2026).
 */
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

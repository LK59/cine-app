/**
 * Les adresses des deux catalogues, et **rien d'autre dans ce fichier**.
 *
 * Elles vivaient dans `src/lib/swr.ts`, qui est du code de navigateur : il importe `swr` et lit
 * l'état de la lecture en cours. Le `layout` du groupe `(player)` est un composant serveur et a
 * besoin de la même adresse pour amorcer le téléchargement du catalogue — l'y importer faisait
 * entrer tout `swr` dans le rendu serveur, où son export `mutate` n'existe pas. Le typage, la
 * vérification de style et les tests passaient tous les trois ; c'est la construction de l'image
 * qui l'a refusé (20/09/2026).
 *
 * Deux constantes seules, sans une ligne d'import : c'est ce qui les rend lisibles des deux côtés.
 * `swr.ts` les réexporte, donc aucun des sept écrans qui les lisent n'a changé.
 */
export const MOVIES_CATALOGUE_KEY = "/api/cinema/movies";
export const SERIES_CATALOGUE_KEY = "/api/cinema/series";

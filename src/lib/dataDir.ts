import path from "node:path";

/**
 * Le seul volume que l'application écrit : la base, le cache d'images, les journaux.
 *
 * Défini ici plutôt que dans `db.ts`, où il vivait, parce que le journal des erreurs en a besoin
 * et ne doit rien devoir à la base de données : c'est le module le plus susceptible d'être en
 * panne au moment précis où l'on écrit une erreur, et une dépendance dans ce sens-là ferait
 * disparaître la trace de la panne avec la panne elle-même.
 */
export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

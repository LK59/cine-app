/**
 * Le build que cette page exécute — ou, côté serveur, celui que le serveur sert.
 *
 * Les deux lisent la même variable, figée dans le code au moment du build (`next.config.js`) : un
 * onglet ouvert avant un déploiement garde donc la valeur de son build à lui, et c'est exactement
 * ce qui permet de le reconnaître comme périmé (`staleBuild.ts`), et de dater chaque ligne du
 * journal du lecteur par le code qui l'a écrite.
 */
export const APP_BUILD = process.env.NEXT_PUBLIC_APP_BUILD ?? "dev";

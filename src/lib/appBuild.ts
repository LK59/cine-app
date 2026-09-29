/**
 * Le build que cette page exécute — ou, côté serveur, celui que le serveur sert.
 *
 * Les deux lisent la même variable, figée dans le code au moment du build (`next.config.js`) : un
 * onglet ouvert avant un déploiement garde donc la valeur de son build à lui, et c'est exactement
 * ce qui permet de le reconnaître comme périmé (`staleBuild.ts`), et de dater chaque ligne du
 * journal du lecteur par le code qui l'a écrite.
 */
export const APP_BUILD = process.env.NEXT_PUBLIC_APP_BUILD ?? "dev";

/**
 * La version de l'application, lue dans `package.json` au build (`next.config.js`) — la seule
 * source. Elle nomme ce qu'on livre, là où `APP_BUILD` nomme le code exact : la première dit
 * « quelle version », la seconde « quel commit ». C'est aussi ce qu'on annonce à Jellyfin, dont
 * la liste des appareils affichait « 1.0.0 » écrit en dur quel que soit le code servi.
 *
 * « dev » hors d'un build Next (la suite de tests), comme `APP_BUILD`.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

/**
 * La version telle qu'on la montre, à la façon d'iOS : « 8.1 » quand le correctif vaut zéro,
 * « 8.1.1 » sinon. Tout ce qui n'a pas la forme majeur.mineur.correctif (« dev », une
 * pré-version) est rendu tel quel plutôt que deviné.
 */
export function displayVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return version;
  const [, major, minor, patch] = match;
  return Number(patch) === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

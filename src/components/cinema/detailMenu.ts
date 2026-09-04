/**
 * Le menu d'une fiche en mode cinéma — une seule description, pour le film et pour la série.
 *
 * Ces chaînes étaient recopiées mot pour mot dans les deux composants.
 */

/**
 * La forme d'une ligne, sans sa couleur.
 *
 * `text-white` a vécu ici, et la ligne blanche essayait de le corriger avec `text-ink` : deux
 * utilitaires de même spécificité, dont c'est l'ordre dans la feuille compilée qui tranche et
 * non l'ordre dans l'attribut. La ligne s'affichait blanc sur blanc. Une couleur se déclare une
 * fois, par la variante qui la porte — ou par une variante d'état, dont la spécificité est
 * supérieure et l'emporte donc de façon prévisible.
 */
export const MENU_ROW =
  "group flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left transition-all duration-200 focus-visible:outline-none";

/**
 * Le sélecteur.
 *
 * Une interface de télévision n'a qu'un seul repère : une ligne blanche qui se déplace. Il y en
 * avait deux ici — la ligne de lecture peinte en blanc pour toujours, et un liseré translucide
 * qui se promenait par-dessus. Le blanc appartient maintenant au focus et à lui seul : il
 * descend avec les flèches, et aucune ligne n'est blanche au repos.
 *
 * `focus-visible:text-ink` l'emporte sur `text-white` par sa pseudo-classe, pas par sa position :
 * c'est ce qui rend le renversement fiable là où deux utilitaires nus ne l'étaient pas.
 */
export const MENU_ROW_INACTIVE =
  "text-white hover:bg-white/10 focus-visible:bg-white focus-visible:text-ink";

/**
 * La pastille d'une ligne.
 *
 * `bg-current/15` plutôt qu'une couleur fixe : elle se teinte du texte de sa ligne, donc claire
 * sur une ligne au repos et sombre sur le sélecteur blanc, sans que rien n'ait à le prévoir.
 */
export const MENU_BADGE =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-current/15 transition-all duration-200";

/**
 * La pastille d'une action déjà accomplie : dans ma liste, déjà vu.
 *
 * L'accent est porté par le fond, jamais par l'icône : l'icône hérite de la couleur de sa ligne
 * et reste donc lisible aussi bien au repos que sous le sélecteur.
 */
export const MENU_BADGE_ACTIVE =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-500/35 ring-1 ring-accent-400/40 transition-all duration-200";

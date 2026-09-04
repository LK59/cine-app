/**
 * Le menu d'une fiche en mode cinéma — une seule description, pour le film et pour la série.
 *
 * Ces cinq chaînes étaient recopiées mot pour mot dans les deux composants.
 */

/**
 * La forme d'une ligne, sans sa couleur.
 *
 * `text-white` vivait ici, et la ligne principale essayait de le corriger avec `text-ink`. Deux
 * utilitaires de couleur de même spécificité : c'est l'ordre dans la feuille compilée qui
 * tranche, pas l'ordre dans l'attribut — et `.text-white` y est écrit après. La ligne blanche
 * s'affichait donc en blanc sur blanc, entièrement vide. La couleur appartient désormais à
 * chaque variante, où rien n'a à être écrasé.
 */
export const MENU_ROW =
  "flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left transition-all duration-200 focus-visible:outline-none";

/**
 * La ligne où l'on se trouve.
 *
 * Elle se lisait moins bien qu'un état, tant que « déjà dans ma liste » se remplissait d'accent.
 * Cette concurrence a disparu, donc le repère n'a plus besoin de crier : un fond un peu plus
 * clair et un liseré discret suffisent, et une ligne restée désignée après un aller-retour dans
 * la page ne saute plus aux yeux comme si elle était sélectionnée.
 */
export const MENU_ROW_INACTIVE =
  "text-white hover:bg-white/10 focus-visible:bg-white/14 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/20";

export const MENU_BADGE =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 transition-all duration-200";

/** La pastille d'une action déjà accomplie : dans ma liste, déjà vu. */
export const MENU_BADGE_ACTIVE =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-500/30 text-accent-300 ring-1 ring-accent-400/40 transition-all duration-200";

/**
 * L'action principale de la fiche : pleine, blanche, lisible de loin.
 *
 * Les cinq lignes du menu avaient le même poids — reprendre, recommencer, bande-annonce, vu,
 * à voir — donc aucune n'était celle qu'on vient chercher. Le fond blanc est ce que fait déjà
 * la version téléphone de cette même fiche ; le bureau ne l'avait jamais reprise.
 *
 * La pastille intérieure du bouton se teinte de la couleur du texte (`bg-current/15`), donc elle
 * suit d'elle-même : claire sur une ligne sombre, sombre sur celle-ci.
 */
export const MENU_ROW_PRIMARY = `${MENU_ROW} bg-white font-semibold text-ink hover:bg-white/90 focus-visible:bg-white focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ink/25`;

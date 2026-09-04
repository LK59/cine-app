/**
 * Le menu d'une fiche en mode cinéma — une seule description, pour le film et pour la série.
 *
 * Ces cinq chaînes étaient recopiées mot pour mot dans les deux composants.
 */

export const MENU_ROW =
  "flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-white transition-all duration-200 focus-visible:outline-none";

/**
 * La ligne où l'on se trouve.
 *
 * C'était `bg-white/10`, c'est-à-dire moins que la ligne « déjà dans ma liste » qui, elle, se
 * remplissait d'accent : sur un menu parcouru à la télécommande, l'endroit où l'on était se
 * lisait moins bien qu'un état. Un fond franc et un liseré clair, et la question ne se pose
 * plus — d'autant que l'accent ne sert plus à marquer un état ici.
 */
export const MENU_ROW_INACTIVE =
  "hover:bg-white/10 focus-visible:bg-white/20 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40";

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
export const MENU_ROW_PRIMARY = `${MENU_ROW} bg-white font-semibold text-ink hover:bg-white/90 focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40`;

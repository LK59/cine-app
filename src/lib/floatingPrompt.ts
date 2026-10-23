/**
 * Où se posent les bannières flottantes du bas de l'écran — « Installer Laterna » et « Réactiver les
 * notifications » : au-dessus de la barre du bas du cinéma, jamais dessus.
 *
 * Posées au bord de l'écran, elles recouvraient exactement la pilule : Accueil, Recherche, Ma liste
 * et Compte ne répondaient plus tant qu'on ne les avait pas fermées (passe de nuit du 15/10/2026,
 * MOBILE-1 / ROBUSTESSE-9). `--player-bar-space` est la réserve que `PlayerShell` pose pour cette
 * barre sur téléphone ; ailleurs elle vaut zéro ou n'existe pas, et la bannière reste au bord.
 *
 * Écrit une fois pour les deux : la même décision prise en deux endroits finit par diverger.
 */
export const ABOVE_BOTTOM_BAR = "calc(max(env(safe-area-inset-bottom), 0.75rem) + var(--player-bar-space, 0px))";

/** La croix de ces bannières : une cible de 44 px, la marge négative garde le dessin à sa place. */
export const PROMPT_CLOSE_CLASS = "-m-3 flex h-11 w-11 shrink-0 items-center justify-center";

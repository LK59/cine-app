/**
 * Le bouton rond des fiches du bureau (`DetailIconActions`, 10.27) : le verre des autres boutons ronds de
 * la fiche (Retour, Partager : `bg-black/55`, `float-edge`), le sélecteur blanc au clavier comme les lignes
 * du menu. À part, pour que `AskTitleControl` et la rangée le partagent sans s'importer l'un l'autre.
 *
 * La forme et les couleurs sont séparées (10.27.1) : en 10.27.0, l'état allumé de « Vu » et « Dans ma liste »
 * (`bg-ink text-brand`) s'ajoutait à `bg-black/55 text-white` sur le même bouton ; deux couleurs de texte et
 * deux fonds dans une même classe, c'est l'ordre de la feuille de Tailwind qui tranche — le blanc l'emportait,
 * et l'or des deux états allumés avait disparu. Un bouton porte la forme et **une seule** des deux teintes.
 */
export const ROUND_ACTION_SHAPE =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full float-edge transition-[color,background-color,box-shadow] duration-200 focus-visible:outline-none";

/** Éteint : le verre, le sélecteur blanc au clavier. */
export const ROUND_ACTION_IDLE = "bg-black/55 text-white hover:bg-white/15 focus-visible:bg-white focus-visible:text-ink";

/**
 * Allumé (déjà vu, dans ma liste) : l'or de la marque sur l'encre, le liseré qui le détache — la pastille
 * allumée des lignes du menu (`MENU_BADGE_ACTIVE`, §83 option B), même jeton `brand`. Au clavier, le
 * sélecteur se dit par un anneau blanc, sans éteindre l'or.
 */
export const ROUND_ACTION_ON = "bg-ink text-brand ring-1 ring-brand/60 hover:bg-ink focus-visible:ring-2 focus-visible:ring-white";

export const ROUND_ACTION = `${ROUND_ACTION_SHAPE} ${ROUND_ACTION_IDLE}`;

/**
 * Le bouton rond des fiches du bureau (`DetailIconActions`, 10.27) : le verre des autres boutons ronds de
 * la fiche (Retour, Partager : `bg-black/55`, `float-edge`), le sélecteur blanc au clavier comme les lignes
 * du menu. À part, pour que `AskTitleControl` et la rangée le partagent sans s'importer l'un l'autre.
 */
export const ROUND_ACTION =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/55 text-white float-edge transition-[color,background-color,box-shadow] duration-200 " +
  "hover:bg-white/15 focus-visible:outline-none focus-visible:bg-white focus-visible:text-ink";

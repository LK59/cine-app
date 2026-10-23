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
/*
 * Des transitions nommées, et non `transition-all` (23/09/2026) : celui-ci animait tout ce qui
 * change, marges et tailles comprises quand la fenêtre franchit le seuil de 820 px de haut. Ne
 * glissent que les couleurs, le fond, l'anneau d'une pastille et l'enfoncement d'une ligne.
 */
export const MENU_ROW =
  "group relative flex w-full items-center gap-3 rounded-lg px-4 py-2 text-left transition-[color,background-color,transform] duration-200 " +
  "focus-visible:outline-none [@media(min-height:820px)]:py-2.5";

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
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-current/15 transition-[color,background-color,box-shadow] duration-200 " +
  "[@media(min-height:820px)]:h-8 [@media(min-height:820px)]:w-8";

/**
 * La pastille d'une action déjà accomplie : dans ma liste, déjà vu.
 *
 * Un état personnel, donc le violet de la marque (§83, option B) : fond plein `brand-strong`,
 * icône blanche — la sienne, pas celle de la ligne, qui devient noire sous le sélecteur blanc.
 * Blanc sur `brand-strong` fait 4,9:1, et le violet se détache aussi bien du sélecteur blanc que
 * de la ligne sombre au repos. (Il suivait le texte, `bg-current/35`, du 13/10 au matin à
 * l'option B : blanc parmi le blanc, rien ne distinguait « vu » de « marquer vu ».)
 */
export const MENU_BADGE_ACTIVE =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-strong text-white ring-1 ring-brand/50 " +
  "transition-[color,background-color,box-shadow] duration-200 [@media(min-height:820px)]:h-8 [@media(min-height:820px)]:w-8";

/**
 * Rendre la main à la première action de la fiche.
 *
 * Un seul chemin, appelé par les cinq retours possibles : l'arrivée sur la fiche, la fermeture
 * de la bande-annonce, celle de la fenêtre du synopsis, celle de la liste des épisodes, et la
 * sortie du lecteur. Ils cherchaient chacun « la première ligne du menu », ce qui était vrai
 * jusqu'à ce que le résumé devienne navigable et se place devant elle : fermer la bande-annonce
 * ramenait alors sur le synopsis. `[data-detail-actions]` désigne le bloc des actions, et lui
 * seul — le résumé est en dehors.
 */
export function focusFirstAction(container: HTMLElement | null | undefined) {
  // Sauf une ligne qui déclenche quelque chose de lourd au premier appui (`data-detail-no-autofocus`)
  // : « Demander » d'une fiche découverte lance un téléchargement chez Radarr ou Sonarr. Posé en
  // premier focus, il partait d'un double Entrée — celui qui ouvre la fiche, puis la touche répétée
  // d'une télécommande (passe de nuit du 15/10/2026, BUREAU-8). Le focus va à la ligne suivante ;
  // la flèche du haut y remonte, et l'appui lui-même ne change pas.
  container?.querySelector<HTMLButtonElement>("[data-detail-actions] [data-detail-menu]:not([data-detail-no-autofocus])")?.focus();
}

/**
 * Haut et Bas dans le menu d'une fiche : la ligne d'avant, la ligne d'après, sans boucler.
 *
 * Le film et la série l'écrivaient chacun dans leur écouteur ; la fiche découverte n'en avait
 * aucun, et sa distribution passée sur la seconde page (14/10/2026) n'aurait été atteignable
 * qu'à la tabulation. Appelée après `similarRowKeyNav`, qui prend la main dès que le focus est
 * dans une rangée. Rend vrai quand elle a traité la touche.
 */
export function detailMenuArrowNav(e: KeyboardEvent, container: HTMLElement | null | undefined): boolean {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
  const rows = Array.from(container?.querySelectorAll<HTMLButtonElement>("[data-detail-menu]") ?? []);
  if (rows.length === 0) return false;
  e.preventDefault();
  const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "ArrowDown") rows[Math.min(idx + 1, rows.length - 1)]?.focus();
  else rows[Math.max(idx - 1, 0)]?.focus();
  return true;
}

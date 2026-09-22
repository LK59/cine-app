/**
 * Le balisage d'une ligne de sous-titre, retiré — pour les deux façons d'en obtenir une.
 *
 * SubRip et WebVTT portent des balises à chevrons : `<i>`, `<b>`, `<font color="…">`, le
 * `<v Locuteur>` de VTT, et ses repères de karaoké `<00:00:01.000>`. Un lecteur qui dessine ses
 * lignes lui-même dans un paragraphe les afficherait telles quelles — c'était le cas des pistes
 * *internes* au Matroska, tandis que les fichiers posés à côté du film, eux, étaient nettoyés
 * depuis toujours. Deux chemins vers le même écran, un seul qui nettoyait : sur Titanic, dont les
 * quatre pistes sont du SubRip interne, une réplique en italique s'affichait entourée de ses
 * balises.
 *
 * Un module à soi plutôt qu'une fonction de plus dans `engine.ts`, et ce n'est pas du rangement :
 * `externalSubtitles.ts` n'empruntait au moteur que des *types*, effacés à la compilation. Lui
 * faire importer une valeur y attache le module entier à l'exécution — que les tests des lecteurs
 * remplacent d'un bloc, si bien que le nettoyage devenait `undefined` et qu'un fichier de
 * sous-titres parfaitement valide était rapporté comme indisponible. Une fonction partagée doit
 * pouvoir être partagée sans traîner le moteur derrière elle.
 *
 * Le découpage est volontairement large — tout ce qui tient entre chevrons. Une réplique qui
 * contiendrait « 5 < 10 » et un « > » plus loin y perdrait son milieu ; c'est le comportement des
 * fichiers externes depuis le début, personne ne l'a jamais rencontré, et le resserrer ferait
 * réapparaître les repères de karaoké que ce même découpage retire.
 */
export function stripSubtitleMarkup(text: string, options: { allBraces?: boolean } = {}): string {
  // La position voulue par le fichier, seule chose gardée des blocs d'override : voir
  // `subtitlePlacement`. Le reste — italique, couleur, karaoké — part.
  const align = /\\an([1-9])/i.exec(text.match(/\{[^}]*\}/g)?.join("") ?? "")?.[1];
  const clean = text
    .replace(/<[^>]*>/g, "")
    // Les blocs d'override ASS, `{\an8}`, `{\i1}` : ils apparaissaient à l'écran, glissés dans
    // des pistes SubRip (sous-titres forcés de *Ted Lasso*, 22/09/2026). Seuls ceux qui commencent
    // par une barre oblique, dans du SubRip — une accolade peut y être du texte. Dans l'ASS, toute
    // accolade est un bloc (les commentaires aussi).
    .replace(options.allBraces ? /\{[^}]*\}/g : /\{\\[^}]*\}/g, "");
  // Rien à placer quand il ne reste rien à dire : une réplique vide doit rester vide, pour être jetée.
  return align && align !== "2" && clean.trim() ? `{\\an${align}}${clean}` : clean;
}

/**
 * Où poser une ligne : en haut quand le fichier le demande (`\an7`, `\an8`, `\an9`), en bas sinon.
 *
 * Les sous-titres forcés qui traduisent un texte à l'image — un panneau, un titre de livre — sont
 * souvent placés en haut, pour ne pas le cacher. `stripSubtitleMarkup` garde cette seule
 * indication, en tête de ligne ; elle est lue ici, au moment de dessiner, et retirée du texte.
 */
export function subtitlePlacement(text: string): { text: string; top: boolean } {
  const match = /^\{\\an([1-9])\}/.exec(text);
  if (!match) return { text, top: false };
  return { text: text.slice(match[0].length), top: ["7", "8", "9"].includes(match[1]) };
}

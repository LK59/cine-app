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
export function stripSubtitleMarkup(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

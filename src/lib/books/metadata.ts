/**
 * Les règles qui rendent présentables les métadonnées des livres (DECISIONS.md §127) — sans réseau,
 * sans base : la série à croire, les noms d'auteurs à rapprocher, les genres à regrouper. Partagées
 * par le serveur (la liste) et l'écran (les rangées, les filtres).
 */

/** Sans accents, sans casse, ponctuation en espaces. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * La clé d'un nom de personne, l'ordre des mots ignoré : « Muchamore Robert » et « Robert Muchamore »
 * sont la même personne (les deux formes coexistent dans une même bibliothèque).
 */
export function nameKey(name: string): string {
  return fold(name).split(" ").filter(Boolean).sort().join(" ");
}

/**
 * La série à afficher pour un livre :
 * 1. celle de l'EPUB lui-même (OPF), quand on l'a lue ;
 * 2. sinon celle de Jellyfin, **seulement** si elle n'est pas en fait le nom d'un dossier — Jellyfin
 *    donne au livre le nom du dossier qui le contient, et une bibliothèque rangée par auteur faisait de
 *    chaque roman isolé un tome de la « série » de son auteur ; d'où le refus d'une série qui porte le
 *    nom d'un auteur du livre (dans n'importe quel ordre) ou d'un dossier racine de bibliothèque ;
 * 3. sinon aucune.
 */
export function decideSeries(input: {
  opfSeries: string | null | undefined;
  jellyfinSeries: string | null | undefined;
  authors: readonly string[];
  libraryFolders: readonly string[];
}): string | null {
  const opf = input.opfSeries?.trim();
  if (opf) return opf;
  const jf = input.jellyfinSeries?.trim();
  if (!jf) return null;
  const key = nameKey(jf);
  if (!key) return null;
  if (input.authors.some((a) => nameKey(a) === key)) return null;
  if (input.libraryFolders.some((f) => nameKey(f) === key)) return null;
  return jf;
}

/** Ce qui n'est pas un genre : des mots de format ou de rayonnage, que trop de fichiers portent. */
const JUNK = new Set(
  ["ebook", "e book", "epub", "livre", "livres", "book", "books", "general", "generale", "unknown", "inconnu", "non classe", "non classifie", "divers", "autre", "autres", "fiction", "non fiction", "litterature", "french", "francais", "fr"].map(fold)
);

/**
 * Les genres d'un livre, à partir de ceux de Jellyfin et des sujets de l'EPUB : coupés sur « / »,
 * « , », « ; », « | » et « & » (« Policier/Thriller » donne deux genres), débarrassés des mots de
 * format, des nombres et des intitulés trop longs pour être un genre, puis dédoublonnés sans accents
 * ni casse. Les libellés sont rendus avec une majuscule.
 */
export function bookGenres(raw: readonly string[]): string[] {
  const out = new Map<string, string>();
  for (const value of raw) {
    for (const part of value.split(/[/,;|&]+/)) {
      const label = part.replace(/\s+/g, " ").trim();
      const key = fold(label);
      if (key.length < 3 || label.length > 32 || /^\d+$/.test(key) || JUNK.has(key)) continue;
      if (!out.has(key)) out.set(key, label.charAt(0).toLocaleUpperCase() + label.slice(1));
    }
  }
  return [...out.values()].slice(0, 12);
}

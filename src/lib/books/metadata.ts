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

/** Les articles qui ne font pas un titre différent : « Le Roi de fer » et « Roi de fer ». */
const LEADING_ARTICLE = /^(?:le|la|les|l|un|une|des|the|a|an)\s+/;

/**
 * La clé d'un titre pour reconnaître deux copies d'un même livre : sans accents ni casse, la ponctuation
 * et « _ » en espaces (« L'amour, vous connaissez » = « L'amour vous connaissez _ »), sans article en tête
 * (« La Pays des fourrures » = « Le pays des fourrures »).
 */
export function titleKey(title: string): string {
  return fold(title.replace(/_/g, " ")).replace(LEADING_ARTICLE, "").trim();
}

/**
 * Un sous-titre de fin qui ne dit que le genre ou la forme du livre, pas un autre livre : « Bazaar: roman »,
 * « Dreamcatcher: a novel », « (poche) ». Jamais « illustrée » : une édition illustrée est gardée à part,
 * exprès. Jamais un tome : « Rêves et cauchemars (Tome 1) » peut être la moitié d'une édition coupée en
 * deux, pas une copie du livre entier.
 */
const GENERIC_SUBTITLE = /^(?:(?:un|une|a|an) )?(?:roman|romans|recit|recits|nouvelle|nouvelles|novel|novella|thriller|poche|livre de poche|edition de poche|(?:nouvelle )?edition(?: (?:revue|augmentee|integrale|originale|definitive|de poche|poche))?)$/;

/** Le titre sans son sous-titre générique de fin (`GENERIC_SUBTITLE`), après « : » ou entre parenthèses. */
function withoutGenericSubtitle(title: string): string {
  const m = /^(.+?)(?:\s*:\s*|\s[-–—]\s+)([^:()[\]]+?)\s*$|^(.+?)\s*[([]\s*([^()[\]]+?)\s*[)\]]\s*$/.exec(title);
  if (!m) return title;
  const head = m[1] ?? m[3];
  const tail = fold(m[2] ?? m[4] ?? "");
  return head && GENERIC_SUBTITLE.test(tail) ? head : title;
}

/**
 * Deux livres de même clé sont deux copies d'un même livre : titre et premier auteur (`nameKey`). Le titre
 * est celui de `titleKey`, plus deux replis mesurés sur une vraie bibliothèque (29/10/2026, Stephen King) :
 * le sous-titre générique de fin (« Désolation » = « Désolation: roman ») et le pluriel — le « s » final
 * de chaque mot ôté (« Coeur perdu en Atlantide » = « Coeurs perdus en Atlantide »), « œ » écrit « oe ».
 * Rien de plus large : « Brume » et « Brume ; La Faucheuse: nouvelles » restent deux livres.
 */
export function duplicateKey(book: { name: string; authors: readonly string[] }): string {
  const title = titleKey(withoutGenericSubtitle(book.name.trim()).replace(/œ/gi, "oe").replace(/æ/gi, "ae"))
    .split(" ")
    .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w))
    .join(" ");
  return `${title}|${nameKey(book.authors[0] ?? "")}`;
}

/**
 * Le soin d'un titre : des accents et des apostrophes (« Prélude à Fondation » plutôt que « Prelude a
 * Fondation »), pas de « _ » (un nom de fichier recopié), puis la longueur (« Le Roi de fer » plutôt que
 * « Roi de fer »).
 */
export function titleCare(title: string): number {
  const accents = (title.match(/[À-ÖØ-öø-ÿŒœ’']/g) ?? []).length;
  const scars = (title.match(/[_]/g) ?? []).length + (/\s[^\p{L}\p{N}\s]\s*$/u.test(title) ? 1 : 0);
  return accents * 10 - scars * 50 + title.trim().length;
}

/**
 * La série à afficher pour un livre : celle que l'EPUB déclare lui-même (OPF — `calibre:series`, ou
 * `belongs-to-collection` en EPUB 3), et elle seule. Jamais celle de Jellyfin : il donne au livre le nom
 * du dossier qui le contient — l'auteur dans une bibliothèque rangée par auteur, « 6000 Romans Ebook en
 * Epub Pack » pour un lot déposé d'un bloc. Pas de série dans l'EPUB, pas de série.
 */
export function decideSeries(input: { opfSeries: string | null | undefined }): string | null {
  return input.opfSeries?.trim() || null;
}

/** Ce qui n'est pas un genre : des mots de format, de langue ou de rayonnage, que trop de fichiers portent. */
const JUNK = new Set(
  [
    "ebook", "e book", "epub", "livre", "livres", "book", "books", "general", "generale", "unknown", "inconnu", "non classe",
    "non classifie", "divers", "autre", "autres", "fiction", "fictions", "non fiction", "litterature", "literature", "french",
    "francais", "fr", "en", "english", "roman", "romans", "novel", "novels", "fiction general", "general fiction", "a lire",
    "nouveaute", "nouveautes", "best seller", "bestseller", "calibre", "import", "imported", "lu", "non lu", "pdf", "mobi",
  ].map(fold)
);

/**
 * Les synonymes, ramenés à un seul libellé (clé sans accents ni casse → libellé). Seulement ce qui est
 * évidemment la même chose : « SF » et « Science-Fiction », « Polar » et « Policier ». « Fantasy » et
 * « Fantastique » restent deux genres (en français, ce n'en est pas un), comme « Policier » et « Thriller ».
 */
const SYNONYMS = new Map<string, string>(
  (
    [
      ["sf", "Science-fiction"],
      ["science fiction", "Science-fiction"],
      ["sci fi", "Science-fiction"],
      ["scifi", "Science-fiction"],
      ["polar", "Policier"],
      ["polars", "Policier"],
      ["policier", "Policier"],
      ["policiers", "Policier"],
      ["roman policier", "Policier"],
      ["romans policiers", "Policier"],
      ["thrillers", "Thriller"],
      ["fantasy fiction", "Fantasy"],
      ["horror", "Horreur"],
      ["young adult", "Jeunesse"],
      ["sentimental", "Romance"],
      ["roman sentimental", "Romance"],
      ["roman historique", "Historique"],
      ["historical fiction", "Historique"],
      ["biography", "Biographie"],
      ["bd", "Bande dessinée"],
      ["bande dessinee", "Bande dessinée"],
      ["aventures", "Aventure"],
      ["adventure", "Aventure"],
    ] as const
  ).map(([k, v]) => [fold(k), v])
);

/** Une valeur qui n'a pas la forme d'un genre : une étiquette (« Lang:fr »), un ISBN, une date, une adresse. */
function looksLikeTag(label: string, key: string): boolean {
  if (/[:=@#]|https?|www\./i.test(label)) return true;
  if (/\d{4,}/.test(key.replace(/\s+/g, ""))) return true;
  return key.split(" ").length > 4;
}

/**
 * Les genres d'un livre, à partir de ceux de Jellyfin et des sujets de l'EPUB : coupés sur « / »,
 * « , », « ; », « | » et « & » (« Policier/Thriller » donne deux genres), débarrassés des mots de
 * format, des étiquettes, des nombres et des intitulés trop longs pour être un genre, les synonymes
 * ramenés à un libellé, puis dédoublonnés sans accents ni casse. Les libellés sont rendus avec une
 * majuscule. Un genre que porte un seul livre de la bibliothèque ne devient ni une rangée ni un choix de
 * filtre : c'est l'index qui le sait (`bookIndex.ts`).
 */
export function bookGenres(raw: readonly string[]): string[] {
  const out = new Map<string, string>();
  for (const value of raw) {
    for (const part of value.split(/[/,;|&]+/)) {
      const label = part.replace(/\s+/g, " ").trim();
      const key = fold(label);
      if (key.length < 2 || label.length > 32 || /^\d+$/.test(key) || JUNK.has(key) || looksLikeTag(label, key)) continue;
      const synonym = SYNONYMS.get(key);
      if (synonym) {
        out.set(fold(synonym), synonym);
        continue;
      }
      if (key.length < 3) continue;
      if (!out.has(key)) out.set(key, label.charAt(0).toLocaleUpperCase() + label.slice(1));
    }
  }
  return [...out.values()].slice(0, 12);
}

/**
 * Les auteurs d'un livre : ceux de Jellyfin (`People`, type `Author`), sinon ceux de l'OPF
 * (`dc:creator`) — Jellyfin n'en connaît pas pour une partie des livres que l'EPUB décrit pourtant.
 * « Nom, Prénom » (la forme de catalogue) est remis dans l'ordre courant ; « Nom Prénom » et
 * « Prénom Nom » sont rapprochés plus loin, par `nameKey`.
 */
export function bookAuthors(jellyfin: readonly string[], opf: readonly string[] | undefined): string[] {
  const source = jellyfin.length > 0 ? jellyfin : (opf ?? []);
  return [...new Set(source.map(readableName).filter(Boolean))].slice(0, 6);
}

function readableName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const comma = /^([^,]+),\s*([^,]+)$/.exec(trimmed);
  return comma ? `${comma[2]} ${comma[1]}` : trimmed;
}

/** « fr-FR », « FRE », « fra » → « fr » ; le reste en minuscules, tel quel. */
export function primaryLanguage(raw: string | null | undefined): string | undefined {
  const head = (raw ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (!head) return undefined;
  const iso2: Record<string, string> = { fre: "fr", fra: "fr", eng: "en", ger: "de", deu: "de", spa: "es", ita: "it", dut: "nl", nld: "nl", por: "pt" };
  return iso2[head] ?? head;
}

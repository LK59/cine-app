/**
 * La casse de la source, rendue à la traduction (DECISIONS.md §69) — par le code, jamais par le
 * modèle.
 *
 * Les vieux sous-titres pour malentendants sont souvent écrits tout en capitales (*La Quatrième
 * Dimension* S00E01 : 89 % des répliques). Haiku 5.5 n'en a recopié les majuscules que sur 118
 * répliques sur 302, au gré des lots : un mélange qui se voit à chaque ligne. Une consigne dans le
 * prompt n'y a rien changé (mesuré le 12/10/2026). La règle est donc déterministe : une réplique
 * source « tout en capitales » donne une traduction tout en capitales ; une réplique en casse normale
 * n'est jamais touchée — et il n'y a pas de normalisation inverse : on reste fidèle à la source.
 */

/** Les balises d'un sous-titre (`<i>`, `{\an8}`), qui ne sont pas du texte et gardent leur casse. */
const MARKUP = /(<[^>]*>|\{[^}]*\})/g;

/** Plus de 80 % des lettres en majuscules, et au moins quatre lettres (un « OK » ne dit rien). */
export function isAllCaps(text: string): boolean {
  const bare = text.replace(MARKUP, "");
  const upper = bare.match(/\p{Lu}/gu)?.length ?? 0;
  const lower = bare.match(/\p{Ll}/gu)?.length ?? 0;
  const letters = upper + lower;
  return letters >= 4 && upper / letters > 0.8;
}

/**
 * La traduction, en capitales si sa source l'est. `toLocaleUpperCase` de la **langue cible** :
 * l'allemand fait de « ß » « SS », le turc de « i » « İ » — une capitale sans la locale serait fausse
 * dans ces deux langues. Les indications entre crochets suivent la même règle que le reste de la
 * ligne, comme dans la source ; seules les balises sont laissées telles quelles.
 */
export function matchSourceCase(source: string, translation: string, target: string): string {
  if (!isAllCaps(source)) return translation;
  const upper = (s: string) => {
    try {
      return s.toLocaleUpperCase(target);
    } catch {
      // Une étiquette de langue que le moteur JavaScript refuse : la capitale sans locale vaut mieux que rien.
      return s.toUpperCase();
    }
  };
  return translation
    .split(MARKUP)
    .map((part, k) => (k % 2 === 1 ? part : upper(part)))
    .join("");
}

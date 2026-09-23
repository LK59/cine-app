/**
 * Le synopsis de la bannière du bureau, arrêté sur une phrase complète.
 *
 * Deux lignes, et la seconde s'estompait vers le bas : on lisait une ombre sous le texte, pas une
 * fin (relevé le 23/09/2026). Une coupure par points de suspension tombe, elle, en plein mot. La
 * forme retenue avec Louis : n'afficher que les phrases entières qui tiennent — le texte se lit
 * alors comme un résumé voulu, sans marque de coupure. Quand même la première phrase déborde, la
 * bannière retombe sur un fondu horizontal en bout de seconde ligne (voir `clamp-fade-end-2`).
 *
 * Les fiches gardent leur propre forme : on y clique, et « Voir plus » ouvre le texte entier.
 */

/**
 * Découpe un texte en phrases.
 *
 * Un point ne termine pas toujours une phrase — « M. Smith », « Dr. Jones », « St. Louis » : on ne
 * coupe qu'après une ponctuation finale suivie d'une majuscule (ou d'un guillemet, d'une
 * parenthèse ouvrante), et un fragment qui finit sur une abréviation — un mot de trois lettres au
 * plus, à majuscule, suivi d'un point — est recollé au suivant. Pas de seuil de longueur : il
 * avalait aussi les vraies phrases courtes (« Le tournoi approche ! »).
 */
const ENDS_ON_ABBREVIATION = /(^|\s)\p{Lu}\p{L}{0,2}\.$/u;

export function splitSentences(text: string): string[] {
  const pieces = text
    .trim()
    .split(/(?<=[.!?…])\s+(?=[«"“(\p{Lu}])/u)
    .filter(Boolean);
  const sentences: string[] = [];
  let carry = "";
  for (const piece of pieces) {
    const joined = carry ? `${carry} ${piece}` : piece;
    if (ENDS_ON_ABBREVIATION.test(joined)) {
      carry = joined;
      continue;
    }
    sentences.push(joined);
    carry = "";
  }
  if (carry) {
    if (sentences.length > 0) sentences[sentences.length - 1] += ` ${carry}`;
    else sentences.push(carry);
  }
  return sentences;
}

/**
 * Les phrases entières qui tiennent, d'après `fits` — ou `null` si même la première déborde.
 *
 * `fits` dit si un texte tient dans la place : c'est l'écran qui le sait, pas une longueur en
 * caractères, puisque la place dépend de la largeur de la fenêtre et de la police.
 */
export function sentencesThatFit(text: string, fits: (candidate: string) => boolean): string | null {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return "";
  let kept: string | null = null;
  for (let i = 1; i <= sentences.length; i++) {
    const candidate = sentences.slice(0, i).join(" ");
    if (!fits(candidate)) break;
    kept = candidate;
  }
  return kept;
}

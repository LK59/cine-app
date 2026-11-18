/**
 * Le rôle d'un crédit TMDB, dans la langue du compte — à l'affichage seulement.
 *
 * TMDB rend les personnages en anglais quelle que soit la langue demandée, avec ses marqueurs :
 * « (uncredited) », « (voice) », « Self », « Self - Guest », « Self (archive footage) », « Narrator (voice) »…
 * Relevé le 18/11/2026 dans le cache de la prod (23 000 rôles distincts) : « (uncredited) » 742 fois,
 * « Self » 705, « (voice) » 460 — une fiche personne en français lisait « Lui (uncredited) » sous la
 * moitié des affiches.
 *
 * Seuls les marqueurs connus sont traduits ; le nom du personnage reste tel quel, et une valeur
 * inconnue revient inchangée. Ce qui est stocké ne change pas : `isAppearance` (filmographyOrder.ts)
 * trie sur la forme anglaise d'origine.
 */

type Translate = (key: string) => string;

/** Les marqueurs entre parenthèses, où qu'ils soient : « Woody (voice) (archive footage) ». */
const PAREN_KEYS: Record<string, string> = {
  voice: "voice",
  uncredited: "uncredited",
  "archive footage": "archiveFootage",
  "archive sound": "archiveSound",
};
const PAREN = /\((voice|uncredited|archive footage|archive sound)\)/gi;

/** « Self » et ses formes, en tête seulement : « Transport Guard (as Joseph Michael Self) » est un rôle. */
const SELF_KEYS: Record<string, string> = { self: "self", himself: "himself", herself: "herself", themselves: "themselves", themself: "themselves" };
const SELF = /^(self|himself|herself|themselves|themself)(?=$|\s*[-–/(])/i;

/** Un segment qui n'est qu'un rôle générique : « Narrator », « The Narrator (voice) », « Self - Guest ». */
const ROLE_KEYS: Record<string, string> = { narrator: "narrator", host: "host", presenter: "presenter", guest: "guest", voice: "voice" };
const ROLE = /^(?:the\s+)?(narrator|host|presenter|guest|voice)(?=$|\s*\()/i;

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

export function characterLabel(raw: string | null | undefined, t: Translate): string {
  if (!raw) return raw ?? "";
  return (
    raw
      // « Self - Guest », « Self / Narrator (voice) » : chaque segment est jugé seul, séparateurs gardés.
      .split(/(\s+[-–/]\s+)/)
      .map((seg) =>
        seg
          .replace(SELF, (m) => t(`person.role.${SELF_KEYS[m.toLowerCase()]}`))
          .replace(ROLE, (_, m: string) => capitalize(t(`person.role.${ROLE_KEYS[m.toLowerCase()]}`)))
      )
      .join("")
      .replace(PAREN, (_, m: string) => `(${t(`person.role.${PAREN_KEYS[m.toLowerCase()]}`)})`)
  );
}

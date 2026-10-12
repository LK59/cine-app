/**
 * La vérification d'un lot traduit (DECISIONS.md §69) — stricte, parce que chaque erreur ici se
 * verrait à l'écran au mauvais moment : une réplique décalée d'un cran rend tout le reste du lot
 * faux, une réplique vide laisse un acteur parler sans texte.
 *
 * Le lot est refusé entier dès qu'une forme cloche (identifiant manquant, en trop, en double) ;
 * une ligne seule peut être refusée (vide, trop de lignes, restée dans la langue source). Le
 * moteur réessaie, réduit le lot de moitié, puis garde le texte source de la ligne qui résiste.
 */

export interface RequestedLine {
  id: number;
  source: string;
}

export type BatchVerdict =
  | { ok: true; texts: Map<number, string> }
  | { ok: false; problem: string; /** Les lignes fautives, quand la faute est dans des lignes. */ bad: number[] };

const words = (s: string) => s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
const flat = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function validateBatch(requested: RequestedLine[], json: unknown): BatchVerdict {
  const items = (json as { translations?: unknown } | null)?.translations;
  if (!Array.isArray(items)) return { ok: false, problem: "forme", bad: [] };
  const wanted = new Map(requested.map((r) => [r.id, r]));
  const texts = new Map<number, string>();
  for (const item of items) {
    const id = (item as { i?: unknown })?.i;
    const text = (item as { text?: unknown })?.text;
    if (typeof id !== "number" || !wanted.has(id)) return { ok: false, problem: "en-trop", bad: [] };
    if (texts.has(id)) return { ok: false, problem: "doublon", bad: [] };
    texts.set(id, typeof text === "string" ? text : "");
  }
  // Une ligne absente, c'est le plus souvent deux répliques fusionnées en une : tout le lot est
  // alors suspect de décalage, pas seulement la ligne manquante.
  if (texts.size !== wanted.size) return { ok: false, problem: "manquant", bad: [] };

  const bad: number[] = [];
  let comparable = 0;
  let unchanged = 0;
  for (const [id, raw] of texts) {
    const source = wanted.get(id)!.source;
    const text = raw
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    texts.set(id, text);
    if (!text) {
      bad.push(id);
      continue;
    }
    const maxLines = Math.max(2, source.split("\n").length);
    if (text.split("\n").length > maxLines) {
      bad.push(id);
      continue;
    }
    if (words(source) >= 3) {
      comparable++;
      if (flat(text) === flat(source)) {
        unchanged++;
        // Une phrase de six mots ou plus rendue à l'identique n'a pas été traduite. En deçà, ce
        // peut être un nom, un juron, une chanson laissée telle quelle : on en juge sur le lot.
        if (words(source) >= 6) bad.push(id);
      }
    }
  }
  if (comparable >= 3 && unchanged * 2 >= comparable) return { ok: false, problem: "langue-source", bad: [] };
  if (bad.length > 0) return { ok: false, problem: "lignes", bad };
  return { ok: true, texts };
}

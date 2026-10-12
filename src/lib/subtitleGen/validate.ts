import { LINE_BREAK } from "./prompts";

/**
 * La lecture et la vérification d'un lot traduit (DECISIONS.md §69) — strictes, parce que chaque
 * erreur ici se verrait à l'écran au mauvais moment : une réplique décalée d'un cran rend tout le
 * reste du lot faux, une réplique vide laisse un acteur parler sans texte.
 *
 * Le lot est refusé entier dès qu'une forme cloche (identifiant manquant, en trop, en double, lot
 * décalé) ; une ligne seule peut être refusée (vide, trop de lignes, restée dans la langue source).
 * Le moteur réessaie, réduit le lot de moitié, puis garde le texte source de la ligne qui résiste.
 */

export interface RequestedLine {
  id: number;
  source: string;
}

export interface ReplyLine {
  i: number;
  text: string;
}

export type BatchVerdict =
  | { ok: true; texts: Map<number, string> }
  | { ok: false; problem: string; /** Les lignes fautives, quand la faute est dans des lignes. */ bad: number[] };

const words = (s: string) => s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
const flat = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ─── Lecture de la réponse ────────────────────────────────────────────────────

const REPLY_LINE = /^\s*(\d+)\s*\|(.*)$/;

/**
 * Une ligne de réponse `id|traduction`, ou rien. ` / ` redevient un saut de ligne. Tout ce qui n'a
 * pas cette forme est ignoré : 2 réponses sur 8 du banc du 12/10/2026 portaient, en plus des
 * quarante lignes justes, une phrase du modèle (« Wait — I need to be careful… »).
 */
export function parseReplyLine(line: string): ReplyLine | null {
  const m = REPLY_LINE.exec(line.replace(/\r/g, ""));
  if (!m) return null;
  return { i: Number(m[1]), text: cleanText(m[2].split(LINE_BREAK).join("\n")) };
}

/** Les lignes d'une traduction : sans blancs autour ni lignes vides. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Toute la réponse d'un lot. Un identifiant répété : **la dernière occurrence l'emporte** — dans le
 * banc, le modèle avait écrit une première ligne fausse, puis « Wait — I need to be careful… », puis
 * reprenait le lot entier, juste. La validation juge ensuite le résultat comme n'importe quel autre.
 */
export function parseReply(text: string): ReplyLine[] {
  const byId = new Map<number, string>();
  for (const line of text.split("\n")) {
    const parsed = parseReplyLine(line);
    if (!parsed) continue;
    byId.delete(parsed.i);
    byId.set(parsed.i, parsed.text);
  }
  return [...byId].map(([i, t]) => ({ i, text: t }));
}

/**
 * Découpe un flux de texte en lignes complètes, au fil des morceaux reçus. La dernière ligne, qu'aucun
 * saut ne termine, n'est jamais rendue : elle arrive avec la réponse entière, que le moteur écrit de
 * toute façon une fois le lot validé.
 */
export class LineSplitter {
  private rest = "";
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: string): void {
    this.rest += chunk;
    let cut: number;
    while ((cut = this.rest.indexOf("\n")) >= 0) {
      const line = this.rest.slice(0, cut);
      this.rest = this.rest.slice(cut + 1);
      this.onLine(line);
    }
  }
}

/** Nombre de lignes à l'écran qu'une traduction peut avoir : deux, ou autant que sa source. */
export function maxLinesFor(source: string): number {
  return Math.max(2, cleanText(source).split("\n").length);
}

/**
 * Ramener une réplique à `max` lignes en recousant les plus courtes voisines, jamais devant une
 * ligne qui ouvre par un tiret (une autre voix d'un dialogue) tant qu'il reste un autre choix.
 */
export function fitLines(text: string, max: number): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  while (lines.length > max) {
    let best = -1;
    let bestLen = Infinity;
    for (const dashOk of [false, true]) {
      for (let k = 0; k + 1 < lines.length; k++) {
        if (!dashOk && lines[k + 1].startsWith("-")) continue;
        const len = lines[k].length + lines[k + 1].length;
        if (len < bestLen) {
          bestLen = len;
          best = k;
        }
      }
      if (best >= 0) break;
    }
    lines.splice(best, 2, `${lines[best]} ${lines[best + 1]}`);
  }
  return lines.join("\n");
}

// ─── Le décalage ──────────────────────────────────────────────────────────────

/**
 * La longueur d'une réplique telle qu'on la lit : sans balises, sauts de ligne comptés comme une
 * espace. Une longueur, pas un contenu : la casse n'y change rien.
 */
function visibleLength(text: string): number {
  return text
    .replace(/<[^>]*>|\{[^}]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

/** Seuils du détecteur, calibrés sur les 12 lots réels du banc (voir `detectDrift`). */
export const DRIFT = {
  /** Une source plus courte ne dit rien de sa traduction (« Yes. » → « Oui, oui. »). */
  minSourceChars: 12,
  high: 2.2,
  low: 0.35,
  /** Répliques hors bornes à partir desquelles le lot est jugé décalé. */
  maxOutliers: 3,
  window: 5,
  shifts: [-2, -1, 1, 2],
  /** Gain moyen (en log de rapport de longueurs) d'un glissement sur une fenêtre. */
  minShiftGain: 0.5,
} as const;

/**
 * Le lot est-il **décalé** — la traduction de la réplique N+k rangée sous N, avec des identifiants
 * pourtant parfaits ? Mesuré le 12/10/2026 : deux lots JSON sur six l'étaient, sur dix lignes
 * d'affilée. Deux signes, tous deux sur les seules longueurs :
 *
 * 1. **Rapports aberrants** : au moins 3 répliques (source ≥ 12 caractères) dont la traduction fait
 *    plus de 2,2 fois ou moins de 0,35 fois la longueur. Lots décalés du banc : 6 et 8 ; lots sains :
 *    2 au plus.
 * 2. **Glissement** : sur une fenêtre de 5 répliques consécutives, les longueurs traduites collent
 *    nettement mieux aux sources décalées de ±1 ou ±2 qu'aux leurs. Écart mesuré en
 *    |log(longueur traduite / (longueur source × rapport médian du lot))|, le rapport médian absorbant
 *    l'allongement propre à la langue cible ; gain moyen ≥ 0,5 = décalé. Lots décalés : 0,76 et
 *    1,04 ; lots sains : 0,25 au plus.
 *
 * `sourceOf` rend la source de n'importe quelle réplique du film (les voisines hors du lot comprises).
 */
export function detectDrift(texts: ReadonlyMap<number, string>, sourceOf: (id: number) => string | undefined): boolean {
  const ids = [...texts.keys()].sort((a, b) => a - b);
  const ratios: number[] = [];
  let outliers = 0;
  for (const id of ids) {
    const src = visibleLength(sourceOf(id) ?? "");
    if (src < DRIFT.minSourceChars) continue;
    const r = visibleLength(texts.get(id)!) / src;
    ratios.push(r);
    if (r > DRIFT.high || r < DRIFT.low) outliers++;
  }
  if (outliers >= DRIFT.maxOutliers) return true;

  const sorted = [...ratios].sort((a, b) => a - b);
  const expected = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 1;
  const dist = (out: number, src: number) => Math.abs(Math.log(Math.max(out, 1) / (Math.max(src, 1) * expected)));
  for (let a = 0; a + DRIFT.window <= ids.length; a++) {
    const win = ids.slice(a, a + DRIFT.window);
    if (win[win.length - 1] - win[0] !== DRIFT.window - 1) continue;
    const outs = win.map((id) => visibleLength(texts.get(id)!));
    const own = win.reduce((sum, id, k) => sum + dist(outs[k], visibleLength(sourceOf(id) ?? "")), 0);
    for (const shift of DRIFT.shifts) {
      const shifted = win.map((id) => sourceOf(id + shift));
      if (shifted.some((s) => s === undefined)) continue;
      const other = win.reduce((sum, _id, k) => sum + dist(outs[k], visibleLength(shifted[k]!)), 0);
      if ((own - other) / DRIFT.window >= DRIFT.minShiftGain) return true;
    }
  }
  return false;
}

// ─── Le lot ───────────────────────────────────────────────────────────────────

/**
 * `items` : la réponse déjà lue (`parseReply`). `sourceOf` permet le détecteur de décalage ; sans
 * lui, seules les sources du lot servent (pas de voisines hors du lot).
 */
export function validateBatch(requested: RequestedLine[], items: readonly ReplyLine[] | null, sourceOf?: (id: number) => string | undefined): BatchVerdict {
  if (!Array.isArray(items)) return { ok: false, problem: "forme", bad: [] };
  const wanted = new Map(requested.map((r) => [r.id, r]));
  const texts = new Map<number, string>();
  for (const item of items) {
    const id = item?.i;
    if (typeof id !== "number" || !wanted.has(id)) return { ok: false, problem: "en-trop", bad: [] };
    if (texts.has(id)) return { ok: false, problem: "doublon", bad: [] };
    texts.set(id, typeof item.text === "string" ? item.text : "");
  }
  // Une ligne absente, c'est le plus souvent deux répliques fusionnées en une : tout le lot est
  // alors suspect de décalage, pas seulement la ligne manquante.
  if (texts.size !== wanted.size) return { ok: false, problem: "manquant", bad: [] };

  const bad: number[] = [];
  let comparable = 0;
  let unchanged = 0;
  for (const [id, raw] of texts) {
    const source = wanted.get(id)!.source;
    const text = cleanText(raw);
    texts.set(id, text);
    if (!text) {
      bad.push(id);
      continue;
    }
    // Deux lignes à l'écran, ou autant que la source : certains vieux SDH ont des répliques de trois
    // lignes, dont la traduction fidèle ne doit pas être refusée.
    // Une ligne de trop n'est pas une faute de traduction : elle est recousue (`fitLines`) plutôt
    // que de refaire tout le lot. Mesuré le 12/10/2026 : 5 lots de 40 refaits pour une seule
    // réplique coupée en trois sur un épisode et demi.
    if (text.split("\n").length > maxLinesFor(source)) texts.set(id, fitLines(text, maxLinesFor(source)));
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
  const sources = sourceOf ?? ((id: number) => wanted.get(id)?.source);
  if (detectDrift(texts, sources)) return { ok: false, problem: "drift", bad: [] };
  return { ok: true, texts };
}

import { repliquesDb } from "./store";
import { words } from "./text";

/**
 * Chercher une réplique (DECISIONS.md §88).
 *
 * La requête est découpée en mots, pliés comme l'index (minuscules, sans accents) ; une ligne doit
 * contenir **tous** les mots. Chaque mot que le vocabulaire ne connaît pas est remplacé par ses
 * voisins les plus proches — une faute de frappe (« persone ») retrouve le mot (« personne ») —, et
 * le dernier mot vaut aussi comme début de mot (« bate » → « bateau ») : on cherche souvent avant
 * d'avoir fini de taper. Le classement : la pertinence de l'index (BM25), plus un bonus quand les
 * mots tapés se suivent tels quels dans la réplique (l'expression exacte passe devant).
 *
 * Les résultats sont groupés par film — quelques répliques chacun, les meilleures —, et `hidden`
 * retire, dans la requête même, les films qu'un compte ne doit pas voir (tags bloqués, §54).
 */

const MAX_WORDS = 8;
/** Les candidats lus avant regroupement : au-delà, on n'apprend plus rien de plus sur les meilleurs films. */
const CANDIDATES = 400;

export interface DialogueLine {
  startMs: number;
  endMs: number;
  lang: string;
  text: string;
}

export interface DialogueFilm {
  itemId: string;
  radarrId: number;
  lines: DialogueLine[];
  /** Combien d'autres répliques de ce film répondent aussi (parmi les candidats lus). */
  more: number;
}

export interface DialogueSearch {
  /** Les mots cherchés, après correction : ce que l'écran met en évidence. */
  terms: string[];
  /** Les débuts de mot (le dernier mot tapé) : un mot affiché qui commence par l'un d'eux est mis en évidence. */
  prefixes: string[];
  films: DialogueFilm[];
}

/** Distance d'édition (une transposition compte pour un), arrêtée dès qu'elle dépasse `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      // « presonne » / « personne » : deux lettres inversées sont une faute, pas deux.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current[j] = value;
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
}

/** La tolérance selon la longueur du mot : aucune sous quatre lettres, une jusqu'à six, deux au-delà. */
function tolerance(word: string): number {
  return word.length < 4 ? 0 : word.length <= 6 ? 1 : 2;
}

/**
 * Les mots du vocabulaire proches de `word`. Les candidats partagent sa première lettre (une faute
 * sur la première lettre est rare, et ce choix borne la lecture à une tranche de l'index du
 * vocabulaire), sont triés par distance puis par fréquence, cinq au plus.
 */
export function corrections(word: string): string[] {
  const max = tolerance(word);
  if (max === 0) return [];
  const first = word[0];
  const next = String.fromCodePoint(first.codePointAt(0)! + 1);
  const rows = repliquesDb()
    .prepare("SELECT term, n FROM terms WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?")
    .all(first, next, word.length - max, word.length + max) as { term: string; n: number }[];
  return rows
    .map((r) => ({ term: r.term, n: r.n, d: editDistance(word, r.term, max) }))
    .filter((r) => r.d <= max)
    .sort((a, b) => a.d - b.d || b.n - a.n)
    .slice(0, 5)
    .map((r) => r.term);
}

function known(word: string): boolean {
  return repliquesDb().prepare("SELECT 1 FROM terms WHERE term = ?").get(word) !== undefined;
}

const quote = (term: string) => `"${term.replace(/"/g, "")}"`;

interface Candidate {
  item_id: string;
  radarr_id: number;
  lang: string;
  start_ms: number;
  end_ms: number;
  text: string;
  norm: string;
  rank: number;
}

export function searchDialogue(
  query: string,
  options: { hidden?: Iterable<string>; itemId?: string; perFilm?: number; films?: number; lang?: string } = {},
): DialogueSearch {
  const typed = words(query).slice(0, MAX_WORDS);
  if (typed.length === 0) return { terms: [], prefixes: [], films: [] };
  const groups: string[] = [];
  const terms = new Set<string>();
  const prefixes: string[] = [];
  typed.forEach((word, index) => {
    const isLast = index === typed.length - 1;
    const alternatives = known(word) ? [word] : corrections(word);
    const parts = alternatives.map(quote);
    for (const a of alternatives) terms.add(a);
    if (isLast && word.length >= 3) {
      parts.push(`${quote(word)}*`);
      prefixes.push(word);
    }
    // Un mot qui ne mène à rien n'empêche pas les autres de trouver — sauf s'il est seul.
    if (parts.length > 0) groups.push(`(${parts.join(" OR ")})`);
  });
  if (groups.length === 0) return { terms: [], prefixes: [], films: [] };

  const hidden = JSON.stringify([...(options.hidden ?? [])]);
  const params: unknown[] = [groups.join(" AND "), hidden];
  let extra = "";
  if (options.itemId) {
    extra += " AND l.item_id = ?";
    params.push(options.itemId);
  }
  if (options.lang) {
    extra += " AND l.lang = ?";
    params.push(options.lang);
  }
  const rows = repliquesDb()
    .prepare(
      `SELECT l.item_id, l.radarr_id, l.lang, l.start_ms, l.end_ms, l.text, l.norm, bm25(lines_fts) AS rank
       FROM lines_fts JOIN lines l ON l.id = lines_fts.rowid
       WHERE lines_fts MATCH ? AND l.item_id NOT IN (SELECT value FROM json_each(?))${extra}
       ORDER BY rank LIMIT ${options.itemId ? 200 : CANDIDATES}`,
    )
    .all(...params) as Candidate[];

  // Le bonus d'expression : les mots tapés, à la suite, dans la réplique.
  const phrase = ` ${typed.join(" ")}`;
  const scored = rows.map((row) => {
    const norm = ` ${row.norm}`;
    let score = -row.rank;
    if (typed.length > 1 && norm.includes(phrase)) score += 10;
    else if (typed.length > 1 && norm.includes(` ${typed.slice(0, -1).join(" ")} ${typed[typed.length - 1]}`)) score += 6;
    return { row, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const perFilm = options.perFilm ?? 3;
  const byFilm = new Map<string, { radarrId: number; score: number; lines: DialogueLine[]; total: number }>();
  for (const { row, score } of scored) {
    let film = byFilm.get(row.item_id);
    if (!film) {
      film = { radarrId: row.radarr_id, score, lines: [], total: 0 };
      byFilm.set(row.item_id, film);
    }
    film.total++;
    // Deux langues du même instant : la même réplique, une fois.
    if (film.lines.length < perFilm && !film.lines.some((l) => Math.abs(l.startMs - row.start_ms) < 1500)) {
      film.lines.push({ startMs: row.start_ms, endMs: row.end_ms, lang: row.lang, text: row.text });
    }
  }
  const films = [...byFilm.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, options.films ?? 20)
    .map(([itemId, f]) => ({ itemId, radarrId: f.radarrId, lines: f.lines, more: Math.max(0, f.total - f.lines.length) }));
  return { terms: [...terms], prefixes, films };
}

/** L'index a-t-il au moins une réplique ? — la section n'apparaît pas sur un index vide. */
export function dialogueIndexHasLines(): boolean {
  return repliquesDb().prepare("SELECT 1 FROM lines LIMIT 1").get() !== undefined;
}

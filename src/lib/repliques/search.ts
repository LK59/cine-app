import { repliquesDb } from "./store";
import { words } from "./text";

/**
 * Chercher une réplique (DECISIONS.md §88).
 *
 * La requête est découpée en mots, pliés comme l'index (minuscules, sans accents) ; une ligne doit
 * contenir **tous** les mots. Chaque mot que le vocabulaire ne connaît pas est remplacé par ses
 * voisins les plus proches — une faute de frappe (« persone ») retrouve le mot (« personne ») —, et
 * le dernier mot vaut aussi comme début de mot (« bate » → « bateau ») : on cherche souvent avant
 * d'avoir fini de taper. Des mots entre guillemets se cherchent tels quels, à la suite.
 *
 * Le classement : la pertinence de l'index (BM25), plus un bonus quand les mots tapés — ou ce qui
 * les a remplacés — se suivent dans la réplique (l'expression exacte passe devant), un moindre quand
 * ils y sont dans l'ordre. Mesuré sur l'index réel (14/10/2026, 1,98 M répliques, banc
 * `repliques-search-bench.spec.ts`), trois rattrapages s'y ajoutent, chacun seulement quand la
 * recherche stricte ne suffit pas :
 *
 * - **une phrase coupée entre deux sous-titres** (« life was like a box of chocolates / you never
 *   know… ») : une réplique et la suivante, prises ensemble (`acrossCues`) ;
 * - **un mot de trop ou faux** (« life *is* like a box of chocolates », la réplique dit *was*) : les
 *   mots rares seuls, puis chacun en moins ; ces résultats sont marqués `approximate` ;
 * - et rien quand **tous** les mots sont parmi les plus courants (« the », « je », « a ») : la
 *   question ne désigne rien, et y répondre tenait la boucle 200 à 340 ms (`tooCommon`).
 *
 * Les résultats sont groupés par film — quelques répliques chacun, les meilleures —, et `hidden`
 * retire, dans la requête même, les films qu'un compte ne doit pas voir (tags bloqués, §54).
 */

const MAX_WORDS = 8;
/** Les candidats lus avant regroupement : au-delà, on n'apprend plus rien de plus sur les meilleurs films. */
const CANDIDATES = 400;
/**
 * Une question dont le mot le **plus rare** apparaît plus souvent que ça n'est pas cherchée. Mesuré :
 * « a » (286 000 répliques) 318 ms, « the » 310 ms, « je » 207 ms de boucle tenue — pour une liste
 * sans aucun sens. Les mots au-delà sont une vingtaine (a, you, i, the, je, est, de, to, it, la, on,
 * pas, le…) ; « je suis » (suis : 25 000) ou « i love you » (love : 8 000) restent cherchés.
 */
export const TOO_COMMON = 60_000;
/**
 * Un dernier mot connu et plus fréquent que ça est un mot fini, pas un début : « you » ne s'étend
 * pas en « young », « yours »… — cette expansion coûtait à elle seule 30 ms sur « i love you ».
 */
const PREFIX_MAX = 20_000;
/** Ce qui compte comme un mot rare, gardé quand on relâche la question. */
const RARE = 20_000;

/**
 * Les seuils ci-dessus sont ceux d'un index de 2 M de répliques (mesuré le 14/10/2026) ; ils
 * grandissent avec lui — « de » ne devient pas plus vague parce que la bibliothèque double. Lue par
 * le plus grand identifiant (instantané : le bout de l'arbre), qui ne recule pas après un effacement :
 * une approximation par excès, sans conséquence.
 */
const REFERENCE_LINES = 2_000_000;
function scale(): number {
  const row = repliquesDb().prepare("SELECT MAX(id) AS n FROM lines").get() as { n: number | null };
  return Math.max(1, (row.n ?? 0) / REFERENCE_LINES);
}
/** En dessous de ce nombre de films, une phrase coupée entre deux sous-titres est cherchée aussi. */
const FEW_FILMS = 3;
/** Le temps laissé aux rattrapages, après la recherche stricte : la boucle n'est pas tenue pour eux. */
const EXTRA_BUDGET_MS = 40;
/** Deux répliques à moins de ça l'une de l'autre sont le même moment (deux langues, deux pistes). */
const SAME_MOMENT_MS = 1500;

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
  /** Combien d'autres **moments** de ce film répondent aussi (parmi les candidats lus). */
  more: number;
}

export interface DialogueSearch {
  /** Les mots trouvés dans les répliques rendues, après correction : ce que l'écran met en évidence. */
  terms: string[];
  /** Les débuts de mot (le dernier mot tapé) : un mot affiché qui commence par l'un d'eux est mis en évidence. */
  prefixes: string[];
  films: DialogueFilm[];
  /** Aucune réplique ne contient tous les mots : ce sont les plus proches. */
  approximate?: boolean;
  /** Les mots sont tous parmi les plus courants : rien n'a été cherché (`TOO_COMMON`). */
  tooCommon?: boolean;
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
    .filter((r) => r.d <= max && r.term !== word)
    .sort((a, b) => a.d - b.d || b.n - a.n)
    .slice(0, 5)
    .map((r) => r.term);
}

/** Le nombre d'occurrences d'un mot dans l'index (0 : inconnu). */
function frequency(word: string): number {
  const row = repliquesDb().prepare("SELECT n FROM terms WHERE term = ?").get(word) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Un mot vu moins souvent que ça est peut-être lui-même une faute — des sous-titres en contiennent :
 * « whats » (2), « cant » (1) ou « cest » (5) sont « connus ». Il est gardé, et ses voisins proposés
 * avec lui ; avant, un mot connu n'était jamais corrigé.
 */
const MAYBE_TYPO = 3;

const quote = (term: string) => `"${term.replace(/"/g, "")}"`;

/** Les terminaisons anglaises qu'une apostrophe détache : don't, it's, I'd, I'm, you're, I'll, I've. */
const ENGLISH_CLITICS = new Set(["s", "t", "d", "m", "re", "ll", "ve"]);
/** Les élisions françaises : l', d', j', m', n', s', t', c', qu', jusqu', lorsqu', puisqu', aujourd'. */
const FRENCH_ELISIONS = new Set(["l", "d", "j", "m", "n", "s", "t", "c", "qu", "jusqu", "lorsqu", "puisqu", "quoiqu", "presqu", "aujourd"]);

/**
 * Un mot tapé collé qui, dans l'index, est en deux (14/10/2026, Louis) : l'apostrophe devient une
 * espace à la normalisation — « don't » est rangé « don t », « l'avancement » « l avancement » — et
 * qui tape « dont » ou « lavancement » ne trouvait rien. « dont » est même un mot français connu :
 * il était cherché tel quel, jamais coupé. Chaque coupure dont les deux morceaux existent dans le
 * vocabulaire devient une expression (« don t »), proposée en plus du mot lui-même. Le trait d'union
 * aussi : « weekend » trouve « week-end ». Rien à réindexer : la forme rangée ne change pas, seule la
 * question s'élargit.
 *
 * Bornée depuis le 14/10/2026 (banc sur l'index réel) : toute coupure dont les deux morceaux
 * existaient était prise, et le vocabulaire contient chaque lettre seule — « the » devenait aussi
 * « t he », et les premières répliques de « the » étaient « ain't he », « isn't he » ; « one »
 * cherchait « o ne » et « on e ». Désormais un morceau d'une lettre n'est pris que là où une
 * apostrophe le détache (élision française à gauche, terminaison anglaise à droite), et un mot
 * **connu** n'est coupé que s'il n'est pas plus fréquent que le plus rare de ses morceaux — « dont » (1 181) devant
 * « don » (41 000) / « t » oui, « the » (195 000) devant « he » (47 000) non.
 */
export function splits(word: string): { left: string; right: string }[] {
  if (word.length < 3) return [];
  const own = frequency(word);
  const out: { left: string; right: string; n: number }[] = [];
  for (let i = 1; i < word.length; i++) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    // Une lettre seule n'est un morceau que là où une apostrophe la détache.
    if (left.length === 1 && !FRENCH_ELISIONS.has(left) && left !== "i") continue;
    if (right.length === 1 && !ENGLISH_CLITICS.has(right)) continue;
    // L'élision française tombe devant une voyelle ou un h muet : « l'heure », pas « l'tout ».
    if (FRENCH_ELISIONS.has(left) && !ENGLISH_CLITICS.has(right) && !/^[aeiouyh]/.test(right)) continue;
    const a = frequency(left);
    if (!a) continue;
    const b = frequency(right);
    if (!b) continue;
    const n = Math.min(a, b);
    if (own > n) continue;
    out.push({ left, right, n });
  }
  return out.sort((x, y) => y.n - x.n).slice(0, 3).map(({ left, right }) => ({ left, right }));
}

/** Un mot de la question, et tout ce qui peut le représenter dans une réplique. */
interface Group {
  word: string;
  /** Les formes d'un seul mot : le mot s'il est connu, ses corrections. */
  forms: string[];
  /** Les formes en deux mots (`splits`). */
  pairs: { left: string; right: string }[];
  prefix: string | null;
  known: boolean;
  /** Le numéro du passage entre guillemets, `null` hors guillemets. */
  quoted: number | null;
  /** Combien de répliques ce mot peut toucher, à peu près : le coût et le sens de la question. */
  freq: number;
}

/** Les mots de la question, en notant ceux qui sont entre guillemets (droits, typographiques, chevrons). */
function parseQuery(query: string): { word: string; quoted: number | null }[] {
  const out: { word: string; quoted: number | null }[] = [];
  let quoted = 0;
  let at = 0;
  for (const match of query.matchAll(/["“”«»„]([^"“”«»„]+)["“”«»„]/g)) {
    for (const word of words(query.slice(at, match.index))) out.push({ word, quoted: null });
    const inside = words(match[1]);
    quoted++;
    for (const word of inside) out.push({ word, quoted: inside.length > 1 ? quoted : -quoted });
    at = (match.index ?? 0) + match[0].length;
  }
  for (const word of words(query.slice(at))) out.push({ word, quoted: null });
  return out.slice(0, MAX_WORDS);
}

function buildGroups(query: string, k: number): Group[] {
  const typed = parseQuery(query);
  const groups: Group[] = [];
  typed.forEach(({ word, quoted }, index) => {
    const own = frequency(word);
    if (quoted !== null) {
      // Entre guillemets : le mot tel quel, ni correction ni coupure ni début de mot.
      if (own > 0) groups.push({ word, forms: [word], pairs: [], prefix: null, known: true, quoted, freq: own });
      else groups.push({ word, forms: [], pairs: [], prefix: null, known: false, quoted, freq: 0 });
      return;
    }
    const forms = own > 0 ? [word] : [];
    if (own < MAYBE_TYPO) forms.push(...corrections(word));
    const pairs = splits(word);
    const isLast = index === typed.length - 1;
    const prefix = isLast && word.length >= 3 && own <= PREFIX_MAX * k ? word : null;
    const freq = forms.reduce((sum, f) => sum + (f === word ? own : frequency(f)), 0) + pairs.reduce((sum, p) => sum + Math.min(frequency(p.left), frequency(p.right)), 0);
    // Un mot qui ne mène à rien n'empêche pas les autres de trouver — sauf s'il est seul.
    if (forms.length + pairs.length > 0 || prefix) groups.push({ word, forms, pairs, prefix, known: own > 0, quoted: null, freq });
  });
  return groups;
}

/** L'expression FTS5 d'une liste de mots : tous requis ; un passage entre guillemets, à la suite. */
function matchExpression(groups: readonly Group[]): string | null {
  const parts: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.quoted !== null && g.quoted > 0) {
      const run = [g];
      while (i + 1 < groups.length && groups[i + 1].quoted === g.quoted) run.push(groups[++i]);
      // Un mot inconnu entre guillemets : l'expression ne peut pas exister.
      if (run.some((r) => r.forms.length === 0)) return null;
      parts.push(`"${run.map((r) => r.word).join(" ")}"`);
      continue;
    }
    const alternatives = g.forms.map(quote);
    for (const { left, right } of g.pairs) alternatives.push(`"${left} ${right}"`);
    if (g.prefix) alternatives.push(`${quote(g.prefix)}*`);
    if (alternatives.length === 0) return null;
    parts.push(`(${alternatives.join(" OR ")})`);
  }
  return parts.length > 0 ? parts.join(" AND ") : null;
}

/** Où chaque mot de la question se trouve dans une réplique (mots normalisés). */
interface Alignment {
  /** Les mots de la question se suivent, dans l'ordre. */
  phrase: boolean;
  /** La plus longue suite de mots de la question enchaînés tels quels. */
  run: number;
  /** Ils y sont dans l'ordre, pas forcément à la suite. */
  ordered: boolean;
  /** Combien de mots de la question y sont. */
  covered: number;
  /** Des mots connus trouvés seulement coupés en deux (« the » lu « t he ») : moins sûrs. */
  splitOnly: number;
  /** Les mots de la réplique qui ont répondu — ce que l'écran met en évidence. */
  matched: string[];
}

interface Span {
  start: number;
  end: number;
}

function align(groups: readonly Group[], tokens: readonly string[]): Alignment {
  const matched = new Set<string>();
  let covered = 0;
  let splitOnly = 0;
  const spans: Span[][] = groups.map((g) => {
    const out: Span[] = [];
    let single = false;
    for (let p = 0; p < tokens.length; p++) {
      const t = tokens[p];
      if (g.forms.includes(t) || (g.prefix && t.startsWith(g.prefix))) {
        out.push({ start: p, end: p + 1 });
        matched.add(t);
        single = true;
      } else if (p + 1 < tokens.length && g.pairs.some((s) => s.left === t && s.right === tokens[p + 1])) {
        out.push({ start: p, end: p + 2 });
        matched.add(t);
        matched.add(tokens[p + 1]);
      }
    }
    if (out.length > 0) covered++;
    if (out.length > 0 && !single && g.known) splitOnly++;
    return out;
  });
  // À la suite : chaque mot commence où le précédent finit. `run` : la plus longue suite de mots de
  // la question ainsi enchaînés — « like a box of chocolates » (5) devant « a box of chocolates » (4).
  let run = 0;
  let previous = new Map<number, number>();
  for (const list of spans) {
    const current = new Map<number, number>();
    for (const s of list) {
      const length = 1 + (previous.get(s.start) ?? 0);
      if (length > (current.get(s.end) ?? 0)) current.set(s.end, length);
      run = Math.max(run, length);
    }
    previous = current;
  }
  const phrase = groups.length > 1 && run === groups.length;
  // Dans l'ordre : la fin la plus tôt possible de chaque mot, après le précédent.
  let at = -1;
  let ordered = groups.length > 1;
  for (const list of spans) {
    const next = list.filter((s) => s.start >= at).reduce((best, s) => Math.min(best, s.end), Infinity);
    if (next === Infinity) {
      ordered = false;
      break;
    }
    at = next;
  }
  return { phrase, run, ordered, covered, splitOnly, matched: [...matched] };
}

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

interface Scored {
  row: Candidate;
  score: number;
  matched: string[];
  a: Alignment;
}

/** Ce qui retire des films de la recherche : cachés au compte, ou tous sauf un (« voir plus »). */
function rowFilter(options: SearchOptions): { sql: string; params: unknown[] } {
  // Filtré dans la sous-requête, avant la limite : un film caché ne prend pas la place d'un autre.
  // Par `rowid` et l'index `lines_item`, jamais par une jointure sur toutes les correspondances :
  // la jointure lisait la ligne de chaque réplique qui répond (des centaines de milliers pour
  // « je suis ») avant de trier — deux fois plus lent, mesuré.
  let sql = " AND rowid NOT IN (SELECT id FROM lines WHERE item_id IN (SELECT value FROM json_each(?)))";
  const params: unknown[] = [JSON.stringify([...(options.hidden ?? [])])];
  if (options.itemId) {
    sql += " AND rowid IN (SELECT id FROM lines WHERE item_id = ?)";
    params.push(options.itemId);
  }
  return { sql, params };
}

function strictRows(expression: string, options: SearchOptions, limit: number): Candidate[] {
  const filter = rowFilter(options);
  return repliquesDb()
    .prepare(
      `SELECT l.item_id, l.radarr_id, l.lang, l.start_ms, l.end_ms, l.text, l.norm, m.rank
       FROM (SELECT rowid, bm25(lines_fts) AS rank FROM lines_fts WHERE lines_fts MATCH ?${filter.sql} ORDER BY rank LIMIT ${limit}) m
       JOIN lines l ON l.id = m.rowid
       ORDER BY m.rank`,
    )
    .all(expression, ...filter.params) as Candidate[];
}

/**
 * Une phrase coupée entre deux sous-titres : la première moitié des mots dans une réplique, la
 * seconde dans la suivante (même film, même langue, au plus quatre secondes après la fin de la
 * première). 10 % des répliques de l'index ne finissent par aucune ponctuation : la phrase continue
 * dans la suivante, et chercher « life was like a box of chocolates you never know » ne trouvait
 * rien. La suivante est lue par son identifiant (`id + 1`, ou `+ 2`) : les répliques d'une piste
 * sont écrites dans l'ordre, et l'index n'a pas de clé (film, langue, instant).
 */
function crossCueRows(first: string, second: string, options: SearchOptions): Candidate[] {
  const filter = rowFilter(options);
  return repliquesDb()
    .prepare(
      `SELECT l1.item_id, l1.radarr_id, l1.lang, l1.start_ms, l2.end_ms,
              l1.text || char(10) || l2.text AS text, l1.norm || ' ' || l2.norm AS norm, m.rank
       FROM (SELECT rowid, bm25(lines_fts) AS rank FROM lines_fts WHERE lines_fts MATCH ?${filter.sql}) m
       JOIN lines l1 ON l1.id = m.rowid
       JOIN lines l2 ON l2.id IN (l1.id + 1, l1.id + 2) AND l2.item_id = l1.item_id AND l2.lang = l1.lang
                     AND l2.start_ms > l1.start_ms AND l2.start_ms <= l1.end_ms + 4000
       WHERE l2.id IN (SELECT rowid FROM lines_fts WHERE lines_fts MATCH ?)
       ORDER BY m.rank LIMIT 100`,
    )
    .all(first, ...filter.params, second) as Candidate[];
}

/** Au-delà de ce nombre de répliques, les mots rares seuls ne bornent plus assez : la requête entière. */
const RARE_FIRST_ROWS = 5000;

/**
 * Les mots rares d'abord. FTS5 lit, pour un `AND`, la liste entière de chaque mot — celle de « de »
 * ou « you » compte des centaines de milliers d'entrées, et le coût croît avec l'index : mesuré sur
 * 10,3 M répliques (l'index réel recopié sept fois), « la vie c'est comme une boîte de chocolat »
 * prenait 280 à 390 ms, « where we're going we don't need roads » 180 ms. Quand la question a des
 * mots rares, eux seuls passent par l'index ; les mots courants sont vérifiés dans les répliques
 * qu'ils ramènent (`align`). Jamais quand la réponse risque d'être tronquée : plus de
 * `RARE_FIRST_ROWS` répliques pour les mots rares, et c'est la requête entière. Entre guillemets,
 * l'expression exacte reste à FTS5.
 */
function rareFirstRows(groups: readonly Group[], options: SearchOptions, k: number): Candidate[] | null {
  if (groups.some((g) => g.quoted !== null)) return null;
  const rare = groups.filter((g) => g.freq < RARE * k);
  if (rare.length === 0 || rare.length === groups.length) return null;
  const expression = matchExpression(rare);
  if (!expression) return null;
  const rows = strictRows(expression, options, RARE_FIRST_ROWS + 1);
  return rows.length > RARE_FIRST_ROWS ? null : rows;
}

interface SearchOptions {
  hidden?: Iterable<string>;
  itemId?: string;
  perFilm?: number;
  films?: number;
}

const rarest = (groups: readonly Group[]) => Math.min(...groups.map((g) => g.freq));

export function searchDialogue(query: string, options: SearchOptions = {}): DialogueSearch {
  const empty: DialogueSearch = { terms: [], prefixes: [], films: [] };
  const k = scale();
  const groups = buildGroups(query, k);
  if (groups.length === 0) return empty;
  const expression = matchExpression(groups);
  if (!expression) return empty;
  // Que des mots parmi les plus courants : rien à chercher (voir `TOO_COMMON`).
  if (rarest(groups) > TOO_COMMON * k) return { ...empty, tooCommon: true };

  const t0 = performance.now();
  const strict: Scored[] = [];
  const score = (row: Candidate, base: number): Scored => {
    const a = align(groups, row.norm.split(" "));
    return { row, matched: a.matched, score: base - row.rank + (a.phrase ? 10 : a.ordered ? 3 : 0) - 4 * a.splitOnly, a };
  };
  const limit = options.itemId ? 200 : CANDIDATES;
  const selective = rareFirstRows(groups, options, k);
  if (selective) {
    // Les mots courants vérifiés ici, mot à mot, comme FTS5 l'aurait fait (formes, coupures à la
    // suite, début de mot) : même réponse, sans lire leurs listes.
    const kept = selective.map((row) => score(row, 0)).filter((s) => s.a.covered === groups.length);
    kept.sort((a, b) => a.row.rank - b.row.rank);
    strict.push(...kept.slice(0, limit));
  } else {
    for (const row of strictRows(expression, options, limit)) strict.push(score(row, 0));
  }

  // Une phrase coupée entre deux sous-titres, quand la recherche stricte trouve peu de films.
  const filmCount = (list: Scored[]) => new Set(list.map((s) => s.row.item_id)).size;
  const quoted = groups.some((g) => g.quoted !== null);
  // Pas quand une réplique a déjà l'expression entière : c'est elle qu'on cherchait.
  if (filmCount(strict) < FEW_FILMS && groups.length >= 3 && !quoted && !strict.some((s) => s.a.phrase)) {
    // L'indice de la coupure s'appelait `k`, comme le facteur d'échelle de l'index qu'il masquait : le
    // seuil valait `TOO_COMMON` × 2, × 3… selon la coupure (14/10/2026).
    for (let cut = 1; cut < groups.length && performance.now() - t0 < EXTRA_BUDGET_MS; cut++) {
      const head = groups.slice(0, cut);
      const tail = groups.slice(cut);
      // Une moitié faite d'un seul mot très courant coûterait sans rien apprendre.
      if (rarest(head) > TOO_COMMON * k || rarest(tail) > TOO_COMMON * k) continue;
      const a = matchExpression(head);
      const b = matchExpression(tail);
      if (!a || !b) continue;
      for (const row of crossCueRows(a, b, options)) {
        // Les mots à la suite, de la fin de l'une au début de l'autre : sans quoi deux répliques
        // voisines qui se partagent des mots courants (« why… so / …seriously ») passaient pour une phrase.
        const s = score(row, 0);
        if (s.a.phrase) strict.push(s);
      }
    }
  }

  // Aucune réplique n'a tous les mots : les plus proches, marquées comme telles.
  let pool = strict;
  let approximate = false;
  if (strict.length === 0 && groups.length >= 3 && !quoted) {
    const rare = groups.filter((g) => g.freq < RARE * k);
    const variants: Group[][] = [];
    if (rare.length >= 2 && rare.length < groups.length) variants.push(rare);
    if (rare.length >= 3) for (let i = 0; i < rare.length; i++) variants.push(rare.filter((_, j) => j !== i));
    const loose: Scored[] = [];
    for (const variant of variants) {
      if (performance.now() - t0 >= EXTRA_BUDGET_MS) break;
      const e = matchExpression(variant);
      if (!e) continue;
      for (const row of strictRows(e, options, 200)) {
        const s = score(row, 0);
        // Au moins trois mots sur cinq de la question, sinon ce n'est plus la même réplique.
        if (s.a.covered < Math.max(2, Math.ceil(groups.length * 0.6))) continue;
        loose.push({ ...s, score: s.score + 5 * s.a.covered + 2 * s.a.run });
      }
    }
    pool = loose;
    approximate = loose.length > 0;
  }
  pool.sort((a, b) => b.score - a.score);

  const perFilm = options.perFilm ?? 3;
  const byFilm = new Map<string, { radarrId: number; score: number; lines: DialogueLine[]; moments: number[] }>();
  const terms = new Set<string>();
  const seen = new Set<string>();
  for (const { row, score: value, matched } of pool) {
    // La même réplique deux fois (deux pistes de la même langue, ou une passe écrite en double) : une fois.
    const key = `${row.item_id}|${row.lang}|${row.start_ms}|${row.norm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let film = byFilm.get(row.item_id);
    if (!film) {
      film = { radarrId: row.radarr_id, score: value, lines: [], moments: [] };
      byFilm.set(row.item_id, film);
    }
    // Deux langues du même instant : la même réplique, une fois — et un seul moment à compter.
    if (film.moments.some((m) => Math.abs(m - row.start_ms) < SAME_MOMENT_MS)) continue;
    film.moments.push(row.start_ms);
    if (film.lines.length < perFilm) {
      film.lines.push({ startMs: row.start_ms, endMs: row.end_ms, lang: row.lang, text: row.text });
      for (const t of matched) terms.add(t);
    }
  }
  const films = [...byFilm.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, options.films ?? 20)
    .map(([itemId, f]) => ({ itemId, radarrId: f.radarrId, lines: f.lines, more: Math.max(0, f.moments.length - f.lines.length) }));
  const prefixes = groups.flatMap((g) => (g.prefix ? [g.prefix] : []));
  return { terms: [...terms], prefixes, films, ...(approximate ? { approximate } : {}) };
}

/** L'index a-t-il au moins une réplique ? — la section n'apparaît pas sur un index vide. */
export function dialogueIndexHasLines(): boolean {
  return repliquesDb().prepare("SELECT 1 FROM lines LIMIT 1").get() !== undefined;
}

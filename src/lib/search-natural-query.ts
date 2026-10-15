import type { Locale } from "@/lib/i18n";

/**
 * Les formes déjà calculées (08/10/2026). La recherche du cinéma compare la frappe à chaque titre de
 * la bibliothèque, et normalisait les deux à chaque appel : environ cinq mille passes de cinq
 * expressions régulières par touche, sur des titres qui ne changent pas. Bornée : vidée d'un coup
 * quand elle déborde, ce qui ne coûte qu'un recalcul.
 */
const NORMALIZED = new Map<string, string>();
const NORMALIZED_MAX = 10_000;

export function normalize(s: string): string {
  const known = NORMALIZED.get(s);
  if (known !== undefined) return known;
  const out = normalizeUncached(s);
  if (NORMALIZED.size >= NORMALIZED_MAX) NORMALIZED.clear();
  NORMALIZED.set(s, out);
  return out;
}

function normalizeUncached(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface NaturalQuery {
  enabled: boolean;
  mediaType: "movie" | "series" | "all";
  genreName: string | null;
  castNames: string[];
  directorNames: string[];
  /** La décennie demandée, par sa première année (1980 pour « les années 80 ») — voir `extractDecade`. */
  decade: number | null;
}

export const GENRE_ALIASES: Record<string, string[]> = {
  action: ["action"],
  adventure: ["aventure", "aventures", "adventure", "aventura", "aventuras", "abenteuer"],
  animation: ["animation", "anime", "animacion", "animación"],
  comedy: ["comedie", "comédie", "humour", "drole", "drôle", "comedy", "comedia", "komodie", "komödie"],
  crime: ["crime", "policier", "policiers", "gangster", "mafia", "crimen", "krimi"],
  documentary: ["documentaire", "docu", "documentary", "documental", "dokumentation", "doku"],
  drama: ["drame", "drama"],
  family: ["famille", "familial", "family", "familia", "familie"],
  fantasy: ["fantastique", "fantasy", "fantasia", "fantasía"],
  history: ["histoire", "historique", "history", "historical", "historia", "historico", "histórico", "geschichte", "historisch"],
  horror: ["horreur", "epouvante", "épouvante", "horror", "terror"],
  music: ["musique", "musical", "music", "musica", "música", "musik"],
  mystery: ["mystere", "mystère", "enquete", "enquête", "mystery", "misterio", "mysterium"],
  romance: ["romance", "romantique", "amour", "romantic", "romantico", "romántico", "romantik"],
  sciencefiction: ["science fiction", "sci fi", "sf", "anticipation", "science-fiction", "ciencia ficcion", "ciencia ficción"],
  thriller: ["thriller", "suspense", "suspenso"],
  tvmovie: ["telefilm", "téléfilm", "tv movie", "fernsehfilm"],
  war: ["guerre", "militaire", "war", "guerra", "krieg", "militar"],
  western: ["western"],
};

export const PERSON_NAME_HINTS = [
  "nuno gallego",
  "christopher nolan",
  "leonardo dicaprio",
  "emma watson",
  "hans zimmer",
  "brad pitt",
  "tom cruise",
  "margot robbie",
  "christian bale",
  "cillian murphy",
  "anne hathaway",
  "matt damon",
  "ryan gosling",
  "scarlett johansson",
  "denis villeneuve",
  "quentin tarantino",
  "steven spielberg",
  "martin scorsese",
];

const STOPWORDS_FR = new Set(["de", "du", "des", "le", "la", "les", "un", "une", "et", "avec", "par"]);
const STOPWORDS_EN = new Set(["the", "a", "an", "of", "with", "by", "and", "in", "on"]);
const STOPWORDS_ES = new Set(["el", "la", "los", "las", "un", "una", "de", "del", "con", "por", "y", "en"]);
const STOPWORDS_DE = new Set(["der", "die", "das", "ein", "eine", "mit", "von", "und", "im", "in", "am"]);
const STOPWORDS = STOPWORDS_FR;

/**
 * Distance d'édition « alignement optimal » (Damerau restreinte) : comme Levenshtein, plus
 * l'inversion de deux lettres voisines comptée pour une faute (15/10/2026, passe de nuit, BUREAU-9).
 *
 * C'est la faute de frappe la plus courante au clavier, et Levenshtein la comptait double :
 * « matrx » (lettre oubliée) trouvait Matrix, « matirx » rien du tout — la tolérance n'était que
 * d'une faute sous sept lettres. Une distance ne peut que baisser par ce cas de plus : une recherche
 * exacte ou par préfixe reste classée comme avant, seules les inversions entrent dans le flou.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let before = Array.from({ length: b.length + 1 }, () => 0);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) curr[j] = Math.min(curr[j], before[j - 2] + 1);
    }
    [before, prev, curr] = [prev, curr, before];
  }
  return prev[b.length];
}

export function correctPersonName(name: string): string {
  const n = normalize(name);
  let best = n;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hint of PERSON_NAME_HINTS) {
    const distance = editDistance(n, hint);
    const limit = hint.length <= 10 ? 1 : 2;
    if (distance <= limit && distance < bestDistance) {
      best = hint;
      bestDistance = distance;
    }
  }
  return best;
}

function wordsNear(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const limit = Math.max(a.length, b.length) >= 7 ? 2 : 1;
  return editDistance(a, b) <= limit;
}

export function titleMatchScore(title: string, query: string): number {
  const titleNorm = normalize(title);
  const queryNorm = normalize(query);
  if (!titleNorm || !queryNorm) return 0;
  if (titleNorm === queryNorm) return 100;
  if (titleNorm.startsWith(queryNorm)) return 90;
  if (titleNorm.includes(queryNorm)) return 75;
  const words = queryNorm.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (words.length > 1 && words.every((w) => titleNorm.includes(w))) return 60;
  // Typo tolerance: every meaningful query word is a near-match (small edit
  // distance) of some word in the title, e.g. "the hunnt" ~ "the hunt".
  const titleWords = titleNorm.split(/\s+/);
  if (words.length > 0 && words.every((w) => titleWords.some((tw) => wordsNear(tw, w)))) return 55;
  return 0;
}

/** Best titleMatchScore across several title variants (e.g. localized, original, English). */
export function bestTitleMatchScore(titles: (string | undefined)[], query: string): number {
  let best = 0;
  for (const title of titles) {
    if (!title) continue;
    best = Math.max(best, titleMatchScore(title, query));
  }
  return best;
}

function splitPeople(value: string, locale: Locale = "fr"): string[] {
  const stopwords = locale === "en" ? STOPWORDS_EN : locale === "es" ? STOPWORDS_ES : locale === "de" ? STOPWORDS_DE : STOPWORDS_FR;
  const splitPattern = locale === "en"
    ? /\s+(?:and|with)\s+|[,/&+]/i
    : locale === "es"
      ? /\s+(?:y|con)\s+|[,/&+]/i
      : locale === "de"
        ? /\s+(?:und|mit)\s+|[,/&+]/i
        : /\s+(?:et|avec)\s+|[,/&+]/i;
  const noiseWords = locale === "en"
    ? /\b(movie|movies|series|show|shows|of|with|by)\b/gi
    : locale === "es"
      ? /\b(pelicula|peliculas|serie|series|con|por|de)\b/gi
      : locale === "de"
        ? /\b(film|filme|serie|serien|mit|von|und)\b/gi
        : /\b(film|films|serie|series|série|séries|de|du|des|avec|par)\b/gi;

  return value
    .split(splitPattern)
    .map((p) => p.replace(noiseWords, " ").replace(/\s+/g, " ").trim())
    .filter((p) => {
      const normalized = normalize(p);
      const words = normalized.split(/\s+/).filter((w) => w && !stopwords.has(w));
      return PERSON_NAME_HINTS.includes(normalized) || words.length >= 2;
    });
}

function extractPeople(q: string, patterns: RegExp[], locale: Locale = "fr"): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = q;
  for (const pattern of patterns) {
    rest = rest.replace(pattern, (_full, raw: string) => {
      names.push(...splitPeople(raw, locale));
      return " ";
    });
  }
  return { names, rest: rest.replace(/\s+/g, " ").trim() };
}

/**
 * Les décennies, dans les quatre langues (15/10/2026, passe de nuit, BUREAU-25, DECISIONS.md §99).
 *
 * « films d'horreur des années 80 » comprenait le genre et pas la décennie : la recherche rendait
 * les films d'horreur les plus populaires du moment, tous de 2026. La grille et le Top 10 savaient
 * déjà filtrer par décennie ; la recherche, non.
 *
 * Une décennie ne se lit **que dans sa tournure** — « années 80 », « années 1980 », « 80s »,
 * « 1980s », « eighties », « años 80 », « los 80 », « 80er (Jahre) », « achtziger » — jamais sur un
 * nombre seul : « 2001 », « 2010 », « Apollo 13 », « 1917 » restent des titres (et, pour un nombre
 * de quatre chiffres, une année : voir `cinemaSearch`). Le mot qui l'introduit (« des », « de los »,
 * « from the », « aus den ») part avec elle, pour ne pas rester comme un bout de titre.
 *
 * Deux chiffres : « 00 » et « 10 » sont 2000 et 2010 ; les autres, le XXᵉ siècle — « les années 20 »
 * sont les Années folles. Les années 2020 se disent avec quatre chiffres.
 */
const DECADE_WORDS: Record<string, number> = {
  // Plus long d'abord : « quatre vingt dix » avant « quatre vingt », « soixante dix » avant « soixante ».
  "quatre vingt dix": 1990, "quatre vingt": 1980, "soixante dix": 1970, soixante: 1960, cinquante: 1950,
  quarante: 1940, trente: 1930, vingt: 1920,
  twenties: 1920, thirties: 1930, forties: 1940, fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990,
  veinte: 1920, treinta: 1930, cuarenta: 1940, cincuenta: 1950, sesenta: 1960, setenta: 1970, ochenta: 1980, noventa: 1990,
  zwanziger: 1920, dreissiger: 1930, vierziger: 1940, funfziger: 1950, sechziger: 1960, siebziger: 1970, achtziger: 1980, neunziger: 1990,
};
const DECADE_WORD_ALT = Object.keys(DECADE_WORDS).sort((a, b) => b.length - a.length).join("|");
// Seuls l'anglais et l'allemand se lisent sans « années » / « años » devant : « trente » ou
// « quarante » seuls sont des titres (« Les Quarante Rugissants »), « eighties » ne l'est guère.
const DECADE_WORD_ALONE = Object.keys(DECADE_WORDS).filter((w) => /(ies|ziger)$/.test(w)).join("|");
// Le mot d'introduction, facultatif, consommé avec la décennie.
const DECADE_LEAD = String.raw`(?:\b(?:des|de|du|from the|from|of the|in the|the|de los|de la decada de los|de la decada de|en los|aus den|in den|der|den)\s+)?`;
const DECADE_NUM = String.raw`((?:19|20)?[0-9]0)`;
const DECADE_PATTERNS: RegExp[] = [
  // FR « années 80 / 1980 / quatre-vingt », ES « años 80 / ochenta », « los 80 ».
  new RegExp(String.raw`${DECADE_LEAD}\b(?:annees?|anos|los|decada de los)\s+(?:${DECADE_NUM}s?|(${DECADE_WORD_ALT}))\b`),
  // EN « 80s / 1980s », DE « 80er / 80ern / 1980er (Jahre) ».
  new RegExp(String.raw`${DECADE_LEAD}\b${DECADE_NUM}(?:s|ern?(?:\s+jahren?)?)\b`),
  // EN « eighties », DE « achtziger (Jahre) ».
  new RegExp(String.raw`${DECADE_LEAD}\b(${DECADE_WORD_ALONE})(?:\s+jahren?)?\b`),
];

function decadeFromDigits(digits: string): number | null {
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n)) return null;
  if (digits.length === 4) return n >= 1900 && n <= 2090 ? n : null;
  return n <= 10 ? 2000 + n : 1900 + n;
}

/**
 * Cherche une décennie dans une requête **déjà normalisée** (`normalize`) ; rend sa première année
 * et la requête sans elle.
 */
export function extractDecade(q: string): { decade: number | null; rest: string } {
  for (const pattern of DECADE_PATTERNS) {
    const m = pattern.exec(q);
    if (!m) continue;
    const digits = m.slice(1).find((g) => g !== undefined && /^[0-9]+$/.test(g));
    const word = m.slice(1).find((g) => g !== undefined && !/^[0-9]+$/.test(g));
    const decade = digits ? decadeFromDigits(digits) : word ? DECADE_WORDS[word] ?? null : null;
    if (decade === null) continue;
    const rest = (q.slice(0, m.index) + " " + q.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    return { decade, rest };
  }
  return { decade: null, rest: q };
}

export function parseNaturalQuery(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
  const { decade, rest: withoutDecade } = extractDecade(q);
  q = withoutDecade;
  const detectedType =
    /\b(film|films|movie|movies)\b/.test(q) ? "movie"
    : /\b(serie|series|série|séries|tv|show)\b/.test(q) ? "series"
    : forcedType;

  q = q.replace(/\b(film|films|movie|movies|serie|series|série|séries|tv|show)\b/g, " ");

  let genreName: string | null = null;
  for (const [canonical, aliases] of Object.entries(GENRE_ALIASES)) {
    const hit = aliases.find((alias) => new RegExp(`\\b${normalize(alias).replace(/\s+/g, "\\s+")}\\b`).test(q));
    if (hit) {
      genreName = canonical;
      q = q.replace(new RegExp(`\\b${normalize(hit).replace(/\s+/g, "\\s+")}\\b`, "g"), " ");
      break;
    }
  }

  const cast = extractPeople(q, [
    /\b(?:avec|joue(?: avec)?|joué par|jouee par|jouée par|acteur|actrice|casting)\s+(.+?)(?=\s+\b(?:realise|réalisé|realisee|réalisée|par|de)\b|$)/gi,
  ]);
  q = cast.rest;

  const director = extractPeople(q, [
    /\b(?:realise par|réalisé par|realisee par|réalisée par|realisateur|réalisateur|realisation|réalisation|par)\s+(.+)$/gi,
    /\bde\s+([a-z][a-z ]{2,})$/gi,
  ]);
  q = director.rest;

  const enabled = Boolean(genreName || cast.names.length || director.names.length || decade !== null);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
    decade,
  };
}

export function parseNaturalQueryEN(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
  const { decade, rest: withoutDecade } = extractDecade(q);
  q = withoutDecade;
  const detectedType =
    /\b(movie|movies|film|films)\b/.test(q) ? "movie"
    : /\b(series|show|shows|tv)\b/.test(q) ? "series"
    : forcedType;

  q = q.replace(/\b(movie|movies|film|films|series|show|shows|tv)\b/g, " ");

  let genreName: string | null = null;
  for (const [canonical, aliases] of Object.entries(GENRE_ALIASES)) {
    const hit = aliases.find((alias) => new RegExp(`\\b${normalize(alias).replace(/\s+/g, "\\s+")}\\b`).test(q));
    if (hit) {
      genreName = canonical;
      q = q.replace(new RegExp(`\\b${normalize(hit).replace(/\s+/g, "\\s+")}\\b`, "g"), " ");
      break;
    }
  }

  const cast = extractPeople(q, [
    /\b(?:with|starring|featuring|actor|actress|cast(?:ing)?)\s+(.+?)(?=\s+\b(?:directed by|director|by)\b|$)/gi,
  ], "en");
  q = cast.rest;

  const director = extractPeople(q, [
    /\b(?:directed by|director)\s+(.+)$/gi,
    /\bby\s+([a-z][a-z ]{2,})$/gi,
  ], "en");
  q = director.rest;

  const enabled = Boolean(genreName || cast.names.length || director.names.length || decade !== null);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
    decade,
  };
}

export function parseNaturalQueryES(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
  const { decade, rest: withoutDecade } = extractDecade(q);
  q = withoutDecade;
  const detectedType =
    /\b(pelicula|peliculas|film|films)\b/.test(q) ? "movie"
    : /\b(serie|series|programa|programas|show)\b/.test(q) ? "series"
    : forcedType;

  q = q.replace(/\b(pelicula|peliculas|film|films|serie|series|programa|programas|show)\b/g, " ");

  let genreName: string | null = null;
  for (const [canonical, aliases] of Object.entries(GENRE_ALIASES)) {
    const hit = aliases.find((alias) => new RegExp(`\\b${normalize(alias).replace(/\s+/g, "\\s+")}\\b`).test(q));
    if (hit) {
      genreName = canonical;
      q = q.replace(new RegExp(`\\b${normalize(hit).replace(/\s+/g, "\\s+")}\\b`, "g"), " ");
      break;
    }
  }

  const cast = extractPeople(q, [
    /\b(?:con|protagonizada por|protagonizado por|actriz|actor|reparto|elenco)\s+(.+?)(?=\s+\b(?:dirigida por|dirigido por|director|de)\b|$)/gi,
  ], "es");
  q = cast.rest;

  const director = extractPeople(q, [
    /\b(?:dirigida por|dirigido por|director(?:a)?)\s+(.+)$/gi,
    /\bde\s+([a-z][a-z ]{2,})$/gi,
  ], "es");
  q = director.rest;

  const enabled = Boolean(genreName || cast.names.length || director.names.length || decade !== null);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
    decade,
  };
}

export function parseNaturalQueryDE(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
  const { decade, rest: withoutDecade } = extractDecade(q);
  q = withoutDecade;
  const detectedType =
    /film(e)?\b/.test(q) ? "movie"
    : /serien?\b|\b(show|sendung)\b/.test(q) ? "series"
    : forcedType;

  // Suffix match (not \b-prefixed) so German compounds like "kriegsfilm" or
  // "krimiserie" are recognized — German freely joins nouns without a space.
  q = q.replace(/film(e)?\b|serien?\b|\b(show|sendung)\b/g, " ");

  let genreName: string | null = null;
  for (const [canonical, aliases] of Object.entries(GENRE_ALIASES)) {
    const hit = aliases.find((alias) => new RegExp(`\\b${normalize(alias).replace(/\s+/g, "\\s+")}\\b`).test(q));
    if (hit) {
      genreName = canonical;
      q = q.replace(new RegExp(`\\b${normalize(hit).replace(/\s+/g, "\\s+")}\\b`, "g"), " ");
      break;
    }
  }

  const cast = extractPeople(q, [
    /\b(?:mit|starring|besetzung|schauspieler|schauspielerin)\s+(.+?)(?=\s+\b(?:regie|regisseur|von|gedreht von)\b|$)/gi,
  ], "de");
  q = cast.rest;

  const director = extractPeople(q, [
    /\b(?:regie von|regie:|gedreht von|regisseur|regisseurin)\s+(.+)$/gi,
    /\bvon\s+([a-z][a-z ]{2,})$/gi,
  ], "de");
  q = director.rest;

  const enabled = Boolean(genreName || cast.names.length || director.names.length || decade !== null);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
    decade,
  };
}

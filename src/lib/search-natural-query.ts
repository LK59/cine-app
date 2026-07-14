import type { Locale } from "@/lib/i18n";

export function normalize(s: string): string {
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
  "clara galle",
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

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
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

export function titleMatchScore(title: string, query: string): number {
  const titleNorm = normalize(title);
  const queryNorm = normalize(query);
  if (!titleNorm || !queryNorm) return 0;
  if (titleNorm === queryNorm) return 100;
  if (titleNorm.startsWith(queryNorm)) return 90;
  if (titleNorm.includes(queryNorm)) return 75;
  const words = queryNorm.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (words.length > 1 && words.every((w) => titleNorm.includes(w))) return 60;
  return 0;
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

export function parseNaturalQuery(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
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

  const enabled = Boolean(genreName || cast.names.length || director.names.length);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
  };
}

export function parseNaturalQueryEN(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
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

  const enabled = Boolean(genreName || cast.names.length || director.names.length);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
  };
}

export function parseNaturalQueryES(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
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

  const enabled = Boolean(genreName || cast.names.length || director.names.length);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
  };
}

export function parseNaturalQueryDE(raw: string, forcedType: "movie" | "series" | "all"): NaturalQuery {
  let q = normalize(raw);
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

  const enabled = Boolean(genreName || cast.names.length || director.names.length);
  return {
    enabled,
    mediaType: detectedType,
    genreName,
    castNames: [...new Set(cast.names.map(normalize))],
    directorNames: [...new Set(director.names.map(normalize))],
  };
}

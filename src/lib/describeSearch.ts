import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { DEFAULT_MODELS } from "@/lib/subtitleGen/pricing";
import { withCache, withPersistentCache } from "@/lib/server-cache";
import type { TmdbTrendingMovie, TmdbTrendingTv } from "@/lib/clients/tmdb";
import { describeKey } from "@/lib/describeQuery";

/**
 * La recherche par description (07/11/2026) : « le film où un type revit la même journée » →
 * *Un jour sans fin*, qu'on l'ait ou non.
 *
 * Deux temps, et seul le premier passe par le modèle :
 * 1. **Reconnaître** — Claude Haiku lit la phrase et rend des titres réels (titre anglais, titre
 *    original, année, film ou série) dans un schéma JSON imposé (`output_config.format`). Rien de
 *    ce qu'il écrit n'est jamais montré : ses titres ne sont que des clés de recherche.
 * 2. **Retrouver** — chaque titre est cherché dans TMDB (`pickTmdbMatch`) et n'est gardé que si
 *    TMDB a ce titre à l'année près. Un titre que le modèle aurait inventé ne trouve rien et
 *    disparaît ; la carte affichée est celle de TMDB, dans la langue de l'interface.
 *
 * Le prompt a été choisi sur banc le 07/11/2026 : 48 descriptions en quatre langues (intrigue,
 * acteur, souvenirs flous, détails faux, fautes de frappe, demandes larges), trois prompts
 * comparés — tous trouvent les descriptions nettes, celui-ci ne rend que le bon titre quand la
 * description en désigne un, là où les autres ajoutaient des « alternatives » sans rapport.
 * 46/48 sur les cas durs (la série belge *Into the Night* lui est inconnue), ~0,9 s médian, ~1,3 s
 * au 90e centile, ~650 jetons d'entrée et ~55 de sortie : moins d'un dixième de centime la recherche.
 *
 * Même fournisseur et même clé que les sous-titres générés (§69) ; Anthropic seulement, Haiku
 * toujours — la réponse doit arriver pendant qu'on regarde l'écran, le modèle réglé pour les
 * sous-titres peut être plus lent. Une même phrase n'est demandée qu'une fois par semaine
 * (cache disque, `describeKey`) : l'historique de recherche relance souvent la même.
 */

export interface DescribedTitle {
  type: "movie" | "series";
  /** Le titre anglais. */
  title: string;
  /** Le titre dans sa langue d'origine. */
  original: string;
  year: number;
}

export const DESCRIBE_MODEL = DEFAULT_MODELS.anthropic;
/** Au-delà, la recherche ordinaire reste seule : une réponse qui tarde n'est plus attendue. */
export const DESCRIBE_TIMEOUT_MS = 12_000;
/** Au plus, ce que le modèle peut rendre (le prompt en demande 8 pour une demande large). */
export const DESCRIBE_MAX_TITLES = 8;

export function describeSearchAvailable(): boolean {
  return (
    config.describeSearch.enabled &&
    config.subtitleGen.provider === "anthropic" &&
    config.subtitleGen.apiKey.trim() !== ""
  );
}

export const DESCRIBE_SYSTEM = `You are the search engine of a home streaming app. A viewer typed a description instead of a title. Work out which films or series they mean.

Rules:
1. A precise description (plot, character, actor, scene) means one title: put it first. Add up to 2 alternatives only if they truly fit as well.
2. A broad request (genre, theme, mood) means several titles: up to 8 well-known, well-rated ones that fit closely.
3. Respect every constraint given (decade, country, language, actor, movie vs series, animation).
4. Only titles that exist and have been released. Never invent. Nothing fits: empty list.
5. type: "movie" or "series" (anime series and mini-series are series). title: English title. original: original-language title. year: release year, or first air year for a series. Exactness matters: they are looked up in TMDB.`;

const SCHEMA = {
  type: "object",
  properties: {
    titles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["movie", "series"] },
          title: { type: "string" },
          original: { type: "string" },
          year: { type: "integer" },
        },
        required: ["type", "title", "original", "year"],
        additionalProperties: false,
      },
    },
  },
  required: ["titles"],
  additionalProperties: false,
} as const;

/** Ce que le modèle a rendu, relu sans lui faire confiance : un titre mal formé est écarté. */
export function parseDescribed(text: string): DescribedTitle[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (raw as { titles?: unknown })?.titles;
  if (!Array.isArray(list)) return [];
  const out: DescribedTitle[] = [];
  for (const item of list) {
    const t = item as Partial<DescribedTitle>;
    if (t.type !== "movie" && t.type !== "series") continue;
    const title = typeof t.title === "string" ? t.title.trim().slice(0, 200) : "";
    const original = typeof t.original === "string" ? t.original.trim().slice(0, 200) : "";
    if (!title && !original) continue;
    const year = typeof t.year === "number" && Number.isInteger(t.year) && t.year > 1870 && t.year < 2200 ? t.year : 0;
    out.push({ type: t.type, title: title || original, original: original || title, year });
    if (out.length >= DESCRIBE_MAX_TITLES) break;
  }
  return out;
}

async function askModel(query: string): Promise<DescribedTitle[]> {
  const client = new Anthropic({ apiKey: config.subtitleGen.apiKey.trim(), maxRetries: 0, timeout: DESCRIBE_TIMEOUT_MS });
  const res = await client.messages.create({
    model: DESCRIBE_MODEL,
    max_tokens: 800,
    system: DESCRIBE_SYSTEM,
    messages: [{ role: "user", content: query }],
    // Haiku 5.5 : sans réflexion (acceptée à l'effort bas) — reconnaître un film n'en a pas besoin,
    // et elle doublait le temps de réponse.
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
  });
  // Un refus ou une réponse coupée ne suivent pas le schéma : rien plutôt qu'une moitié de JSON.
  if (res.stop_reason !== "end_turn") return [];
  return parseDescribed(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
}

let identify: (query: string) => Promise<DescribedTitle[]> = askModel;

/** Remplace le modèle dans les tests — aucun appel réseau réel n'y part. */
export function setDescribeModelForTests(fn: ((query: string) => Promise<DescribedTitle[]>) | null): void {
  identify = fn ?? askModel;
}

/**
 * Les titres qu'une phrase désigne. Gardés une semaine sur disque par phrase normalisée — la langue
 * de l'interface n'y entre pas, le modèle rend les mêmes titres. Une erreur n'est pas gardée.
 */
export function describedTitles(query: string): Promise<DescribedTitle[]> {
  return withPersistentCache(`describe:v1:${describeKey(query)}`, 7 * 24 * 3600_000, () => identify(query));
}

/** Un titre pour comparer : minuscules, sans accents ni ponctuation. */
export function foldTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9Ѐ-ӿ぀-ヿ一-鿿가-힯]+/g, " ")
    .trim();
}

type TmdbHit = TmdbTrendingMovie | TmdbTrendingTv;

function hitYear(hit: TmdbHit): number | null {
  const date = "release_date" in hit ? hit.release_date : hit.first_air_date;
  const year = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : null;
}

/**
 * Le résultat TMDB qui est bien ce titre, ou `null`.
 *
 * Le même titre (anglais ou original, à la casse et aux accents près) et la même année à un an
 * près — une sortie en festival puis en salle, une série datée de son pilote. À défaut de titre
 * identique, le premier résultat de TMDB s'il est exactement de l'année : un titre traduit
 * autrement (« Intouchables » / « The Intouchables »). Rien d'autre : mieux vaut aucune carte
 * qu'un homonyme d'une autre époque.
 */
export function pickTmdbMatch(wanted: DescribedTitle, hits: TmdbHit[]): TmdbHit | null {
  const names = new Set([foldTitle(wanted.title), foldTitle(wanted.original)].filter(Boolean));
  const near = (hit: TmdbHit) => {
    const year = hitYear(hit);
    return wanted.year === 0 || year === null || Math.abs(year - wanted.year) <= 1;
  };
  const named = hits.filter((hit) => {
    const own = "title" in hit ? [hit.title, hit.original_title] : [hit.name, hit.original_name];
    return own.some((n) => n && names.has(foldTitle(n)));
  });
  const exact = named.find((hit) => near(hit) && hitYear(hit) === wanted.year);
  if (exact) return exact;
  const close = named.find(near);
  if (close) return close;
  const first = hits[0];
  return first && wanted.year !== 0 && hitYear(first) === wanted.year ? first : null;
}

export interface TmdbSearcher {
  searchMovies(query: string): Promise<{ results: TmdbTrendingMovie[] }>;
  searchTv(query: string): Promise<{ results: TmdbTrendingTv[] }>;
}

/**
 * Un titre reconnu, retrouvé dans TMDB dans la langue de `client` : par son titre original, puis
 * par son titre anglais. Gardé un jour par langue — TMDB est la même clé pour toute la maison.
 */
export function findOnTmdb(wanted: DescribedTitle, client: TmdbSearcher, locale: string): Promise<TmdbHit | null> {
  const key = `describe:tmdb:v1:${locale}:${wanted.type}:${wanted.year}:${foldTitle(wanted.original)}:${foldTitle(wanted.title)}`;
  return withCache(key, 24 * 3600_000, async () => {
    const search = (q: string) =>
      (wanted.type === "movie" ? client.searchMovies(q) : client.searchTv(q)).then((r) => r.results as TmdbHit[]);
    for (const q of [...new Set([wanted.original, wanted.title])]) {
      if (!q) continue;
      const hit = pickTmdbMatch(wanted, await search(q));
      if (hit) return hit;
    }
    return null;
  });
}

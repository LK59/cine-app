import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import type { JellyfinItem } from "@/lib/clients/jellyfin";
import type { JellyfinOnlyTitle } from "@/lib/catalogueMembers";
import type { SonarrEpisodeText } from "@/lib/server-cache";
import { getProviderIdCI } from "@/lib/server-cache";
import { arrangeEpisodes, fileKey, type ArrangedEpisode } from "@/lib/episodeDisplay";
import { mapInBatches } from "@/lib/inBatches";
import type {
  CheckCategory,
  CheckFinding,
  EpisodeWitness,
  ExternalIds,
  HardlinkFinding,
  IdentityFinding,
  JellyfinOnlyFinding,
  MisfiledFinding,
  MisfiledSignal,
  NumberingFinding,
  SeriesArbiter,
  TmdbFacts,
} from "./types";

/**
 * Le contrôle de la bibliothèque : où Jellyfin, Radarr/Sonarr, TMDB et le disque se contredisent
 * (DECISIONS.md §90). **Lecture seule** : rien ici n'écrit chez un service ; l'analyse dit qui a
 * probablement raison et quel geste faire, l'administrateur décide.
 *
 * Tout est en fonctions pures sur des données déjà lues (`run.ts` les lit), plus trois questions à
 * TMDB passées en dépendances — les tests les remplacent, la route les sert depuis les caches.
 */

// ─── Les seuils, écrits une fois ─────────────────────────────────────────────

/**
 * Un fichier « d'une autre durée » que son film (catégorie d). Prudent exprès : une version longue
 * ajoute couramment 10 à 30 minutes (*Aliens* Special Edition : 154 min pour 137), une version
 * « extended » jusqu'à 30 % (*Le Seigneur des anneaux*). Il faut donc **les deux** : au moins
 * 30 minutes **et** au moins 30 % d'écart — ou un fichier de moins de la moitié de la durée attendue
 * (un extrait, un épisode). Mesurée sur le fichier par Radarr (`mediaInfo.runTime`), sinon par
 * Jellyfin ; attendue selon TMDB (`runtime` de Radarr).
 *
 * La durée seule n'aurait pas trouvé *Aliens* rangé avec *Alien³* (Special Assembly Cut, 145 min pour
 * 137 attendues) : c'est le nom d'origine du fichier qui le trahit (`NAME_YEAR`), ou Jellyfin qui y
 * voyait un autre film dont TMDB donne la durée (`JELLYFIN_RUNTIME`).
 */
export const DURATION_MIN_GAP_MINUTES = 30;
export const DURATION_MIN_GAP_RATIO = 0.3;
export const DURATION_FRAGMENT_RATIO = 0.5;
/**
 * Le film que Jellyfin croit voir explique mieux la durée du fichier : à 8 minutes près du sien, et à
 * 15 au moins de celui de Radarr.
 */
export const JELLYFIN_RUNTIME_CLOSE = 8;
export const JELLYFIN_RUNTIME_FAR = 15;
/** Une année « du film » dans un nom : à un an près (sortie en salles et sortie TMDB diffèrent). */
export const NAME_YEAR_TOLERANCE = 1;
/** …et ne compte pas quand la durée du fichier est celle du film à trois minutes près. */
export const NAME_YEAR_RUNTIME_MATCH = 3;
/** Une version longue annoncée dans le nom : l'écart de durée en plus n'est pas un indice. */
export const LONG_EDITION = /\b(extended|director'?s[ ._-]?cut|dc|roadshow|special[ ._-]?edition|unrated|uncut|ultimate|final[ ._-]?cut|version[ ._-]?longue|integrale|int[ée]grale|remastered[ ._-]?extended|imax[ ._-]?enhanced)\b/i;
/** L'arbitre penche à partir de ce score (de −1,25 à +1,25). */
export const ARBITER_THRESHOLD = 0.3;
/** Coût borné : séries arbitrées par analyse, épisodes comparés par série. */
export const MAX_ARBITRATED_SERIES = 40;
export const MAX_WITNESSES = 8;

// ─── Petits outils ───────────────────────────────────────────────────────────

/** « 2:34:28 », « 02:34:28 », « 1:46 » → minutes. */
export function parseRunTime(text: string | null | undefined): number | null {
  if (!text) return null;
  const parts = text.trim().split(":").map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  const minutes = h * 60 + m + s / 60;
  return minutes > 0 ? minutes : null;
}

const baseName = (path: string | null | undefined) => (path ? path.replace(/\\/g, "/").split("/").pop() ?? null : null);

/**
 * Les années qu'un nom de fichier porte — délimitées : « 2160p », « x265 », « 1080 » n'en sont pas.
 * Un nombre qui fait partie du titre du film (*1917*, *2012*) n'en est pas une non plus.
 */
export function yearsInName(name: string | null | undefined, title?: string | null): number[] {
  if (!name) return [];
  const inTitle = new Set((title ?? "").match(/\d{4}/g) ?? []);
  const found = [...name.matchAll(/(?<![0-9])(19\d{2}|20\d{2})(?![0-9])/g)].map((m) => m[1]).filter((y) => !inTitle.has(y));
  return [...new Set(found.map(Number))];
}

const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "le", "la", "les", "l", "de", "des", "du", "d", "et", "un", "une", "part", "partie", "chapter", "chapitre"]);

/** Les mots d'un titre, sans accents, ponctuation ni mots vides. */
export function titleWords(title: string | null | undefined): string[] {
  if (!title) return [];
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP_WORDS.has(w));
}

/**
 * La ressemblance de deux titres, de 0 à 1 : Jaccard sur les mots ; 1 s'ils sont identiques ; 0,8 si
 * l'un contient tous les mots de l'autre (au moins deux) — « Stendhal Syndrome » et « The Stendhal
 * Syndrome (Part 1) ».
 */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const wa = new Set(titleWords(a));
  const wb = new Set(titleWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const jaccard = common / (wa.size + wb.size - common);
  if (jaccard === 1) return 1;
  const smaller = Math.min(wa.size, wb.size);
  if (common === smaller && smaller >= 2) return Math.max(jaccard, 0.8);
  return jaccard;
}

/** La meilleure ressemblance d'un titre avec l'un des titres TMDB (français puis anglais). */
const bestSimilarity = (title: string | null | undefined, candidates: readonly string[]) =>
  candidates.length === 0 || !title ? null : Math.max(...candidates.map((c) => titleSimilarity(title, c)));

const sxe = (season: number, episode: number) => `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

const positive = (raw: string | undefined | null): number | null => {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

function jellyfinIds(item: JellyfinItem): ExternalIds {
  const ids = item.ProviderIds as Record<string, string> | undefined;
  return {
    tmdbId: positive(getProviderIdCI(ids, "tmdb")),
    tvdbId: positive(getProviderIdCI(ids, "tvdb")),
    imdbId: getProviderIdCI(ids, "imdb")?.trim() || null,
  };
}

/** Deux identités se contredisent quand un identifiant présent des deux côtés diffère — ou que Jellyfin n'en a aucun. */
export function identitiesDisagree(catalogue: ExternalIds, jellyfin: ExternalIds): boolean {
  if (jellyfin.tmdbId === null && jellyfin.tvdbId === null && jellyfin.imdbId === null) return true;
  const differ = <T,>(a: T | null, b: T | null) => a !== null && b !== null && a !== b;
  return differ(catalogue.tmdbId, jellyfin.tmdbId) || differ(catalogue.tvdbId, jellyfin.tvdbId) || differ(catalogue.imdbId, jellyfin.imdbId);
}

// ─── d. Le fichier n'est probablement pas le film ────────────────────────────

/**
 * Les indices qu'un fichier rangé par Radarr est un autre film. Aucun ne lit le disque : la durée
 * mesurée par Radarr (ou Jellyfin), le nom d'origine du fichier (Radarr le garde), et la durée TMDB du
 * film que Jellyfin croit voir. Jellyfin n'expose pas le titre Matroska du conteneur (vérifié le
 * 14/10/2026 : `MediaSources.Name` est le nom du fichier, le `Title` de la piste vidéo absent) — le nom
 * d'origine le remplace.
 */
export function misfiledSignals(input: {
  title: string;
  year: number | null;
  expectedMinutes: number | null;
  fileMinutes: number | null;
  originalNames: (string | null | undefined)[];
  jellyfinRuntime?: number | null;
  /** L'édition que Radarr a lue dans la release (`movieFile.edition`) : « Extended », « Director's Cut »… */
  edition?: string | null;
}): { signals: MisfiledSignal[]; nameYears: number[]; originalName: string | null } {
  const signals: MisfiledSignal[] = [];
  const { expectedMinutes: expected, fileMinutes: file } = input;
  const originalName = input.originalNames.map(baseName).find((n): n is string => !!n) ?? null;
  // Une version longue annoncée n'est pas un mauvais fichier : *Les Deux Tours* Extended (235 min pour
  // 179) et *Kingdom of Heaven* Roadshow (194 pour 144) dépassaient les deux seuils (mesure du 14/10/2026).
  const longEdition = !!input.edition?.trim() || input.originalNames.some((n) => LONG_EDITION.test(baseName(n) ?? ""));
  if (expected && expected >= 20 && file) {
    const gap = Math.abs(file - expected);
    if (file < expected * DURATION_FRAGMENT_RATIO || (gap >= DURATION_MIN_GAP_MINUTES && gap >= expected * DURATION_MIN_GAP_RATIO && !(file > expected && longEdition))) {
      signals.push("duration");
    }
  }
  const nameYears = [...new Set(input.originalNames.flatMap((n) => yearsInName(baseName(n), input.title)))];
  // Une durée juste à trois minutes près l'emporte sur l'année d'un nom de release : *Le Chef* (2012),
  // publié sous « Comme.un.Chef.2014 », dure 85 minutes pour 84 attendues — c'est bien lui.
  const runtimeMatches = !!expected && !!file && Math.abs(file - expected) <= NAME_YEAR_RUNTIME_MATCH;
  if (input.year && nameYears.length > 0 && !nameYears.some((y) => Math.abs(y - input.year!) <= NAME_YEAR_TOLERANCE) && !runtimeMatches) signals.push("nameYear");
  if (file && expected && input.jellyfinRuntime && Math.abs(file - input.jellyfinRuntime) <= JELLYFIN_RUNTIME_CLOSE && Math.abs(file - expected) >= JELLYFIN_RUNTIME_FAR) {
    signals.push("jellyfinRuntime");
  }
  return { signals, nameYears, originalName };
}

/**
 * Films en désaccord d'identité : la durée du fichier départage, au plus près (de 10 minutes au moins)
 * de l'un des deux films TMDB ; sinon l'année du nom d'origine, si elle est celle d'un seul des deux —
 * *November* : fichier de 106 min entre *Novembre* (2022, 100 min) et *November* (2017, 115 min),
 * nommé « November (2022) » : Radarr a raison, Jellyfin est à réaligner.
 */
export function movieIdentityVerdict(
  fileMinutes: number | null,
  catalogueRuntime: number | null,
  jellyfinRuntime: number | null,
  years: { nameYears?: number[]; catalogueYear?: number | null; jellyfinYear?: number | null } = {}
): "catalogue" | "jellyfin" | "unknown" {
  if (fileMinutes && catalogueRuntime && jellyfinRuntime) {
    const toCatalogue = Math.abs(fileMinutes - catalogueRuntime);
    const toJellyfin = Math.abs(fileMinutes - jellyfinRuntime);
    if (toJellyfin + 10 <= toCatalogue) return "jellyfin";
    if (toCatalogue + 10 <= toJellyfin) return "catalogue";
  }
  const near = (y: number | null | undefined) => !!y && (years.nameYears ?? []).some((n) => Math.abs(n - y) <= NAME_YEAR_TOLERANCE);
  const cat = near(years.catalogueYear);
  const jf = near(years.jellyfinYear);
  if (cat && !jf) return "catalogue";
  if (jf && !cat) return "jellyfin";
  return "unknown";
}

// ─── c. La numérotation, et l'arbitre TMDB ───────────────────────────────────

export interface NumberingComparison {
  compared: number;
  unattached: number;
  mismatched: { arranged: ArrangedEpisode; attached: SonarrEpisodeText[] }[];
}

/**
 * Les épisodes du disque que Sonarr rattache à un autre numéro — la même règle que la fiche
 * (`applyAttachedEpisodeText`) : un fichier dont aucun épisode rattaché n'a le numéro du disque.
 */
export function compareNumbering(arranged: readonly ArrangedEpisode[], attached: readonly SonarrEpisodeText[]): NumberingComparison {
  const byFile = new Map<string, SonarrEpisodeText[]>();
  for (const a of attached) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  let compared = 0;
  let unattached = 0;
  const mismatched: NumberingComparison["mismatched"] = [];
  for (const ep of arranged) {
    const key = fileKey(ep.item.Path);
    const candidates = key ? byFile.get(key) : undefined;
    if (!candidates?.length) {
      unattached++;
      continue;
    }
    compared++;
    if (!candidates.some((a) => a.season === ep.seasonNumber && a.episode === ep.episodeNumber)) mismatched.push({ arranged: ep, attached: candidates });
  }
  return { compared, unattached, mismatched };
}

/** Le nombre d'épisodes de chaque saison du disque (hors spéciaux). */
export function diskSeasonCounts(arranged: readonly ArrangedEpisode[]): Map<number, number> {
  const seen = new Map<number, Set<number>>();
  for (const ep of arranged) {
    if (ep.seasonNumber <= 0) continue;
    (seen.get(ep.seasonNumber) ?? seen.set(ep.seasonNumber, new Set()).get(ep.seasonNumber)!).add(ep.episodeNumber);
  }
  return new Map([...seen].map(([s, eps]) => [s, eps.size]));
}

/** Combien de saisons du disque ont exactement le nombre d'épisodes de chaque référence. */
function countMatches(disk: Map<number, number>, refs: (Record<string, number> | null)[]): { compared: number; matches: number[] } {
  const matches = refs.map(() => 0);
  let compared = 0;
  for (const [season, count] of disk) {
    if (!refs.some((r) => r && r[String(season)] !== undefined)) continue;
    compared++;
    refs.forEach((r, i) => {
      if (r && r[String(season)] === count) matches[i]++;
    });
  }
  return { compared, matches };
}

const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

const verdictOf = (score: number, hasEvidence: boolean): SeriesArbiter["verdict"] =>
  !hasEvidence ? "unknown" : score >= ARBITER_THRESHOLD ? "jellyfin" : score <= -ARBITER_THRESHOLD ? "catalogue" : "unknown";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ArbiterDeps {
  /** Les titres TMDB (français, anglais) des épisodes d'une saison, par numéro. */
  seasonTitles: (tmdbId: number, season: number) => Promise<Map<number, string[]>>;
}

/**
 * L'arbitre d'une série dont Sonarr numérote autrement que le disque (catégorie c). TMDB est une source
 * indépendante de Sonarr (qui suit TVDB) : pour chaque fichier concerné, le titre que Jellyfin lui
 * donne et celui de l'épisode que Sonarr lui rattache sont comparés au titre TMDB **au numéro du
 * disque** ; et le nombre d'épisodes de chaque saison du disque à celui de TMDB et de Sonarr.
 * - Jellyfin ressemble à TMDB, Sonarr non : le disque suit l'ordre de TMDB, c'est Sonarr qui numérote
 *   autrement — « Jellyfin probablement juste » ;
 * - Sonarr ressemble à TMDB au numéro du disque : les deux désignent le même épisode, et le texte de
 *   Sonarr est le bon — « Sonarr probablement juste » ;
 * - sinon, indéterminé.
 * Score = moyenne Jellyfin − moyenne Sonarr, ± 0,25 si les saisons penchent. Jamais d'action seule.
 */
export async function arbitrateNumbering(
  comparison: NumberingComparison,
  diskCounts: Map<number, number>,
  tmdbId: number | null,
  tmdbSeasons: Record<string, number> | null,
  sonarrSeasons: Record<string, number> | null,
  deps: ArbiterDeps
): Promise<SeriesArbiter> {
  const sample = comparison.mismatched.slice(0, MAX_WITNESSES);
  const seasonCache = new Map<number, Promise<Map<number, string[]>>>();
  const titlesAt = (season: number) => {
    if (!tmdbId) return Promise.resolve(new Map<number, string[]>());
    if (!seasonCache.has(season)) seasonCache.set(season, deps.seasonTitles(tmdbId, season).catch(() => new Map()));
    return seasonCache.get(season)!;
  };
  const examples: EpisodeWitness[] = [];
  for (const { arranged, attached } of sample) {
    const tmdbTitles = (await titlesAt(arranged.seasonNumber)).get(arranged.episodeNumber) ?? [];
    const sonarrTitle = attached.map((a) => a.title).find((t) => t && !/^(tba|tbd)$/i.test(t)) ?? null;
    examples.push({
      disk: sxe(arranged.seasonNumber, arranged.episodeNumber),
      jellyfin: arranged.item.Name ?? null,
      tmdbAtDisk: tmdbTitles[0] ?? null,
      sonarr: attached.map((a) => sxe(a.season, a.episode)),
      sonarrTitle,
      jellyfinScore: tmdbTitles.length ? round2(bestSimilarity(arranged.item.Name, tmdbTitles) ?? 0) : null,
      sonarrScore: tmdbTitles.length && sonarrTitle ? round2(bestSimilarity(sonarrTitle, tmdbTitles) ?? 0) : null,
    });
  }
  const jellyfinTitles = mean(examples.map((e) => e.jellyfinScore));
  const sonarrTitles = mean(examples.map((e) => e.sonarrScore));
  const counts = countMatches(diskCounts, [tmdbSeasons, sonarrSeasons]);
  let score = 0;
  if (jellyfinTitles !== null) score += jellyfinTitles - (sonarrTitles ?? 0);
  const countLean = counts.compared > 0 ? Math.sign(counts.matches[0] - counts.matches[1]) * 0.25 : 0;
  score += countLean;
  const hasEvidence = jellyfinTitles !== null || countLean !== 0;
  return {
    verdict: verdictOf(score, hasEvidence),
    score: round2(score),
    jellyfinTitles: jellyfinTitles === null ? null : round2(jellyfinTitles),
    sonarrTitles: sonarrTitles === null ? null : round2(sonarrTitles),
    seasonCounts: counts.compared > 0 ? { compared: counts.compared, tmdb: counts.matches[0], sonarr: counts.matches[1] } : null,
    examples: examples.slice(0, 3),
  };
}

/**
 * L'arbitre d'une série dont Jellyfin et Sonarr donnent deux identités (catégorie b) : les titres des
 * épisodes du disque, que Jellyfin lit, ressemblent-ils à ceux de la série de **Sonarr** chez TMDB ? Et
 * les saisons du disque ont-elles le compte de la série TMDB de Sonarr, ou de celle de Jellyfin ?
 * Positif : le dossier contient la série que Jellyfin croit voir. `seasonCounts.tmdb` compte la série de
 * Sonarr, `seasonCounts.other` celle de Jellyfin.
 */
export async function arbitrateIdentity(
  arranged: readonly ArrangedEpisode[],
  catalogueTmdb: TmdbFacts | null,
  jellyfinTmdb: TmdbFacts | null,
  sonarrSeasons: Record<string, number> | null,
  deps: ArbiterDeps
): Promise<SeriesArbiter> {
  const regular = arranged.filter((e) => e.seasonNumber > 0);
  // Quelques épisodes répartis sur la série, pas les huit premiers d'une même saison.
  const step = Math.max(1, Math.floor(regular.length / MAX_WITNESSES));
  const sample = regular.filter((_, i) => i % step === 0).slice(0, MAX_WITNESSES);
  const examples: EpisodeWitness[] = [];
  if (catalogueTmdb) {
    const seasons = new Map<number, Promise<Map<number, string[]>>>();
    for (const ep of sample) {
      if (!seasons.has(ep.seasonNumber)) seasons.set(ep.seasonNumber, deps.seasonTitles(catalogueTmdb.tmdbId, ep.seasonNumber).catch(() => new Map()));
      const titles = (await seasons.get(ep.seasonNumber)!).get(ep.episodeNumber) ?? [];
      examples.push({
        disk: sxe(ep.seasonNumber, ep.episodeNumber),
        jellyfin: ep.item.Name ?? null,
        tmdbAtDisk: titles[0] ?? null,
        sonarr: [],
        sonarrTitle: null,
        jellyfinScore: titles.length ? round2(bestSimilarity(ep.item.Name, titles) ?? 0) : null,
        sonarrScore: null,
      });
    }
  }
  const disk = diskSeasonCounts(arranged);
  const counts = countMatches(disk, [catalogueTmdb?.seasons ?? null, jellyfinTmdb?.seasons ?? null, sonarrSeasons]);
  const titleCat = mean(examples.map((e) => e.jellyfinScore));
  let score = 0;
  // Les titres du disque sont ceux de la série de Sonarr : Jellyfin s'est trompé de fiche.
  if (titleCat !== null) score += 0.5 - titleCat;
  if (counts.compared > 0) score += (0.5 * (counts.matches[1] - Math.max(counts.matches[0], counts.matches[2]))) / counts.compared;
  const hasEvidence = titleCat !== null || counts.compared > 0;
  return {
    verdict: verdictOf(score, hasEvidence),
    score: round2(score),
    jellyfinTitles: null,
    sonarrTitles: titleCat === null ? null : round2(titleCat),
    seasonCounts: counts.compared > 0 ? { compared: counts.compared, tmdb: counts.matches[0], other: counts.matches[1], sonarr: counts.matches[2] } : null,
    examples: examples.slice(0, 3),
  };
}

/** Saison → nombre d'épisodes chez Sonarr (tous les épisodes connus, hors spéciaux). */
export function sonarrSeasonCounts(series: SonarrSeries): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const s of series.seasons ?? []) {
    if (s.seasonNumber <= 0) continue;
    const n = s.statistics?.totalEpisodeCount ?? s.statistics?.episodeCount;
    if (n !== undefined) out[String(s.seasonNumber)] = n;
  }
  return Object.keys(out).length ? out : null;
}

// ─── L'analyse ───────────────────────────────────────────────────────────────

export interface CheckInput {
  configured: { radarr: boolean; sonarr: boolean };
  /** null : le service est configuré mais n'a pas répondu — sa partie du contrôle est sautée. */
  movies: RadarrMovie[] | null;
  series: SonarrSeries[] | null;
  matchedMovies: { m: RadarrMovie; jfItem: JellyfinItem }[];
  matchedSeries: { s: SonarrSeries; jfItem: JellyfinItem }[];
  onlyMovies: JellyfinOnlyTitle[];
  onlySeries: JellyfinOnlyTitle[];
  /** Par série Sonarr : ce qu'il rattache à chaque fichier, et les épisodes que Jellyfin a sur le disque. */
  seriesData: Map<number, { attached: SonarrEpisodeText[]; episodes: JellyfinItem[] }>;
  /** null : le dossier des médias n'est pas monté. */
  hardlinks: { folders: [string, string]; files: number }[] | null;
  trusted: ReadonlySet<number>;
}

export interface CheckDeps extends ArbiterDeps {
  movieFacts: (tmdbId: number) => Promise<TmdbFacts | null>;
  tvFacts: (tmdbId: number) => Promise<TmdbFacts | null>;
  /** Appelé entre deux étapes : la progression, et une respiration de la boucle. */
  progress?: (step: string, done: number, total: number) => Promise<void> | void;
}

const folderOf = (path: string | null | undefined): string | null => (path ? path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? null : null);
const movieFolderOf = (path: string | null | undefined) => folderOf(path?.replace(/[\\/][^\\/]*$/, ""));

export async function analyseLibrary(input: CheckInput, deps: CheckDeps): Promise<{ findings: CheckFinding[]; counts: Record<CheckCategory, number> }> {
  const findings: CheckFinding[] = [];
  const safe = <T,>(p: Promise<T | null>) => p.catch(() => null);

  // a. Ce que Jellyfin a seul.
  for (const t of input.onlyMovies) {
    findings.push({
      category: "jellyfinOnly",
      key: `jellyfinOnly:movie:${t.item.Id}`,
      kind: "movie",
      title: t.item.Name ?? "",
      year: t.item.ProductionYear ?? null,
      folder: movieFolderOf(t.item.Path),
      verdict: "info",
      jellyfinId: t.item.Id,
      catalogueId: t.id,
      ids: { tmdbId: t.tmdbId, tvdbId: t.tvdbId, imdbId: t.imdbId },
      serviceConfigured: input.configured.radarr,
    } satisfies JellyfinOnlyFinding);
  }
  for (const t of input.onlySeries) {
    findings.push({
      category: "jellyfinOnly",
      key: `jellyfinOnly:series:${t.item.Id}`,
      kind: "series",
      title: t.item.Name ?? "",
      year: t.item.ProductionYear ?? null,
      folder: folderOf(t.item.Path),
      verdict: "info",
      jellyfinId: t.item.Id,
      catalogueId: t.id,
      ids: { tmdbId: t.tmdbId, tvdbId: t.tvdbId, imdbId: t.imdbId },
      serviceConfigured: input.configured.sonarr,
    } satisfies JellyfinOnlyFinding);
  }

  // b + d. Les films.
  const movieTotal = input.matchedMovies.length;
  let movieDone = 0;
  await mapInBatches(input.matchedMovies, 25, async ({ m, jfItem }) => {
    movieDone++;
    const catalogue: ExternalIds = { tmdbId: m.tmdbId > 0 ? m.tmdbId : null, tvdbId: null, imdbId: m.imdbId?.trim() || null };
    const jf = { ...jellyfinIds(jfItem), tvdbId: null };
    const disagree = identitiesDisagree(catalogue, jf);
    const fileMinutes = parseRunTime(m.movieFile?.mediaInfo?.runTime) ?? (jfItem.RunTimeTicks ? jfItem.RunTimeTicks / 600_000_000 : null);
    let expected = m.runtime && m.runtime > 0 ? m.runtime : null;
    const jellyfinTmdb = disagree && jf.tmdbId ? await safe(deps.movieFacts(jf.tmdbId)) : null;
    const catalogueTmdb = disagree && catalogue.tmdbId ? await safe(deps.movieFacts(catalogue.tmdbId)) : null;
    expected ??= catalogueTmdb?.runtime ?? null;
    const misfiled = misfiledSignals({
      title: m.title,
      year: m.year || null,
      expectedMinutes: expected,
      fileMinutes,
      originalNames: [m.movieFile?.originalFilePath, m.movieFile?.sceneName],
      jellyfinRuntime: jellyfinTmdb?.runtime ?? null,
      edition: m.movieFile?.edition ?? null,
    });
    const base = { kind: "movie" as const, title: m.title, year: m.year || null, folder: folderOf(m.path) };
    if (misfiled.signals.length > 0) {
      findings.push({
        ...base,
        category: "misfiled",
        key: `misfiled:movie:${m.id}`,
        verdict: "file",
        catalogueId: m.id,
        jellyfinId: jfItem.Id,
        signals: misfiled.signals,
        fileMinutes: fileMinutes === null ? null : Math.round(fileMinutes),
        expectedMinutes: expected,
        originalName: misfiled.originalName,
        nameYears: misfiled.nameYears,
        jellyfinTmdb,
      } satisfies MisfiledFinding);
    } else if (disagree) {
      findings.push({
        ...base,
        category: "identity",
        key: `identity:movie:${m.id}`,
        verdict: movieIdentityVerdict(fileMinutes, expected, jellyfinTmdb?.runtime ?? null, {
          nameYears: misfiled.nameYears,
          catalogueYear: m.year || null,
          jellyfinYear: jellyfinTmdb?.year ?? jfItem.ProductionYear ?? null,
        }),
        catalogueId: m.id,
        jellyfinId: jfItem.Id,
        catalogue,
        jellyfin: { ...jf, name: jfItem.Name ?? "", year: jfItem.ProductionYear ?? null },
        catalogueTmdb,
        jellyfinTmdb,
        fileMinutes: fileMinutes === null ? null : Math.round(fileMinutes),
      } satisfies IdentityFinding);
    }
    return null;
  });
  await deps.progress?.("movies", movieDone, movieTotal);

  // b + c. Les séries.
  let arbitrated = 0;
  let seriesDone = 0;
  for (const { s, jfItem } of input.matchedSeries) {
    seriesDone++;
    if (seriesDone % 10 === 0) await deps.progress?.("series", seriesDone, input.matchedSeries.length);
    const data = input.seriesData.get(s.id);
    const arranged = data ? arrangeEpisodes(data.episodes, jfItem.Name ?? s.title, "fr") : [];
    const catalogue: ExternalIds = { tmdbId: s.tmdbId && s.tmdbId > 0 ? s.tmdbId : null, tvdbId: s.tvdbId > 0 ? s.tvdbId : null, imdbId: s.imdbId?.trim() || null };
    const jf = jellyfinIds(jfItem);
    const trusted = input.trusted.has(s.id);
    const base = { kind: "series" as const, title: s.title, year: s.year || null, folder: folderOf(s.path) };
    const sonarrSeasons = sonarrSeasonCounts(s);
    const budget = () => arbitrated < MAX_ARBITRATED_SERIES;

    if (identitiesDisagree(catalogue, jf)) {
      const canArbitrate = budget() && arranged.length > 0;
      if (canArbitrate) arbitrated++;
      const catalogueTmdb = canArbitrate && catalogue.tmdbId ? await safe(deps.tvFacts(catalogue.tmdbId)) : null;
      const jellyfinTmdb = canArbitrate && jf.tmdbId && jf.tmdbId !== catalogue.tmdbId ? await safe(deps.tvFacts(jf.tmdbId)) : null;
      const arbiter = canArbitrate ? await arbitrateIdentity(arranged, catalogueTmdb, jellyfinTmdb, sonarrSeasons, deps).catch(() => null) : null;
      findings.push({
        ...base,
        category: "identity",
        key: `identity:series:${s.id}`,
        verdict: arbiter?.verdict === "jellyfin" ? "jellyfin" : arbiter?.verdict === "catalogue" ? "catalogue" : "unknown",
        catalogueId: s.id,
        jellyfinId: jfItem.Id,
        catalogue,
        jellyfin: { ...jf, name: jfItem.Name ?? "", year: jfItem.ProductionYear ?? null },
        catalogueTmdb,
        jellyfinTmdb,
        fileMinutes: null,
        arbiter,
        trusted,
      } satisfies IdentityFinding);
    }

    if (data && arranged.length > 0) {
      const comparison = compareNumbering(arranged, data.attached);
      if (comparison.mismatched.length > 0) {
        const canArbitrate = budget();
        if (canArbitrate) arbitrated++;
        const tmdbFacts = canArbitrate && catalogue.tmdbId ? await safe(deps.tvFacts(catalogue.tmdbId)) : null;
        const arbiter = canArbitrate
          ? await arbitrateNumbering(comparison, diskSeasonCounts(arranged), catalogue.tmdbId, tmdbFacts?.seasons ?? null, sonarrSeasons, deps).catch(() => null)
          : null;
        findings.push({
          ...base,
          category: "numbering",
          key: `numbering:series:${s.id}`,
          verdict: arbiter?.verdict ?? "unknown",
          sonarrId: s.id,
          seriesType: s.seriesType ?? null,
          mismatched: comparison.mismatched.length,
          compared: comparison.compared,
          unattached: comparison.unattached,
          arbiter,
          trusted,
        } satisfies NumberingFinding);
      }
    }
  }

  // e. Les doubles rangements par liens physiques.
  for (const pair of input.hardlinks ?? []) {
    findings.push({
      category: "hardlinks",
      key: `hardlinks:${pair.folders.join("|")}`,
      kind: pair.folders.some((f) => f.startsWith("tv/")) ? "series" : "movie",
      title: pair.folders.map((f) => f.split("/").slice(1).join("/")).join(" · "),
      year: null,
      folder: null,
      verdict: "info",
      folders: pair.folders,
      files: pair.files,
    } satisfies HardlinkFinding);
  }

  const counts = { jellyfinOnly: 0, identity: 0, numbering: 0, misfiled: 0, hardlinks: 0 } as Record<CheckCategory, number>;
  for (const f of findings) counts[f.category]++;
  return { findings, counts };
}

// ─── e. Les liens physiques, lus par `find` ──────────────────────────────────

/**
 * Les paires de dossiers de titre qui partagent des fichiers vidéo (même inode), à partir des lignes
 * `dev:ino<TAB>chemin` de `find … -links +1 -exec stat`. Un même inode sous deux dossiers *du même*
 * titre (deux saisons) ne compte pas, ni le lien vers le dossier des seeds (`find` ne le parcourt pas).
 */
export function hardlinkPairs(lines: string, roots: { prefix: string; label: string }[]): { folders: [string, string]; files: number }[] {
  const byInode = new Map<string, Set<string>>();
  for (const line of lines.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const inode = line.slice(0, tab);
    const path = line.slice(tab + 1);
    const root = roots.find((r) => path.startsWith(r.prefix.endsWith("/") ? r.prefix : r.prefix + "/"));
    if (!root) continue;
    const title = path.slice(root.prefix.replace(/\/$/, "").length + 1).split("/")[0];
    if (!title) continue;
    (byInode.get(inode) ?? byInode.set(inode, new Set()).get(inode)!).add(`${root.label}/${title}`);
  }
  const pairs = new Map<string, { folders: [string, string]; files: number }>();
  for (const folders of byInode.values()) {
    const list = [...folders].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}|${list[j]}`;
        const entry = pairs.get(key) ?? { folders: [list[i], list[j]] as [string, string], files: 0 };
        entry.files++;
        pairs.set(key, entry);
      }
    }
  }
  return [...pairs.values()].sort((a, b) => b.files - a.files || a.folders[0].localeCompare(b.folders[0]));
}

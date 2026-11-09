import { tmdb, TMDB_IMAGE_BASE, type TmdbCreditedPerson } from "@/lib/clients/tmdb";
import { jellyfin } from "@/lib/clients/jellyfin";
import { getProviderIdCI, withCache, withPersistentCache } from "@/lib/server-cache";
import { mapInBatches } from "@/lib/inBatches";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { getTitleNames } from "@/lib/titleNames";

/**
 * Ce que l'analyse des acteurs à l'écran sait d'un élément (DECISIONS.md §138) : où est son fichier,
 * quelle version, et qui joue dedans — la distribution de **cet** épisode ou de ce film, prise chez
 * TMDB, avec plusieurs photos par personne pour que le service reconnaisse un visage sous plusieurs
 * angles et à plusieurs âges.
 *
 * Les réponses de TMDB ne sont jamais gardées entières : seulement leur projection (CLAUDE.md, « Cache
 * *projections* »), sous des clés de consultation — `credits:xray:v1:…` et `person:xray-photos:v1:…` —
 * que le ménage du disque efface après quatorze jours et que la sauvegarde laisse de côté.
 */

/** Assez pour un film choral ; au-delà, des figurants que personne ne cherche à l'écran. */
export const XRAY_CAST_MAX = 40;
/** Les photos d'une personne envoyées au service : différents angles et âges, sans tout son album. */
export const XRAY_PHOTOS_PER_PERSON = 8;
/** La largeur des photos : celle des vignettes de distribution du cinéma, assez pour un visage. */
const PHOTO_WIDTH = "w185";
const WEEK_MS = 7 * 24 * 3600_000;

export type TmdbRef = { kind: "movie"; id: number } | { kind: "episode"; tvId: number; season: number; episode: number };

export interface AnalysisTarget {
  itemId: string;
  type: "Movie" | "Episode";
  /** Le fichier tel que Jellyfin le voit — le service monte la médiathèque au même chemin. */
  path: string;
  /** La version du fichier : un résultat d'un autre `etag` est périmé. */
  etag: string;
  seriesId: string | null;
  tmdb: TmdbRef | null;
  /**
   * La durée du fichier selon Jellyfin (secondes ; celle de la source, sinon de l'élément), `null`
   * inconnue. Un fichier remplacé à durée égale (± 1 s) garde son analyse (§138, planificateur).
   */
  durationS: number | null;
}

/** Une personne de la distribution, telle que l'analyse et le lecteur la lisent. */
export interface XrayPerson {
  personId: number;
  name: string;
  character: string;
  order: number;
  /** Le chemin TMDB de la photo principale (`/abc.jpg`), ou `null`. */
  profilePath: string | null;
}

/**
 * La langue d'origine du titre (« en »), pour que le service écoute la version originale (« qui parle »,
 * 10.30) : celle que le catalogue tient déjà de TMDB (`getTitleNames`, gardée, sans appel de plus quand le
 * titre est connu). Inconnue ou illisible : `null`, le service prend la piste par défaut.
 */
export function originalLanguageOf(tmdb: TmdbRef | null): string | null {
  if (!tmdb) return null;
  try {
    const names = getTitleNames(tmdb.kind === "movie" ? tmdb.id : tmdb.tvId, tmdb.kind === "movie" ? "movie" : "series");
    return typeof names.originalLanguage === "string" && /^[a-z]{2,3}$/i.test(names.originalLanguage) ? names.originalLanguage.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function tmdbPhotoUrl(filePath: string): string {
  return `${TMDB_IMAGE_BASE}/${PHOTO_WIDTH}${filePath}`;
}

const positiveInt = (n: unknown): number | null => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null);

/**
 * L'élément vu par Jellyfin, et son titre chez TMDB. Gardé dix minutes en mémoire : la route du lecteur
 * le relit à chaque ouverture, et un fichier remplacé change d'`ETag` — la borne dit quand on l'apprend.
 * `null` : élément inconnu, sans fichier, ou ni film ni épisode.
 */
export function analysisTarget(itemId: string): Promise<AnalysisTarget | null> {
  return withCache(`xray:target:${itemId}`, 10 * 60_000, async () => {
    const item = await jellyfin.getItemForAnalysis(itemId);
    if (!item || (item.Type !== "Movie" && item.Type !== "Episode")) return null;
    const source = item.MediaSources?.[0];
    const path = source?.Path || item.Path || "";
    if (!path) return null;
    // L'`ETag` de la source, sinon la taille : le contrat accepte l'un ou l'autre, tant qu'il change
    // avec le fichier.
    const etag = source?.ETag || (typeof source?.Size === "number" ? `size:${source.Size}` : "");
    if (!etag) return null;
    const ticks = source?.RunTimeTicks || item.RunTimeTicks || 0;
    const durationS = ticks > 0 ? Math.round(ticks / 10_000) / 1000 : null;
    if (item.Type === "Movie") {
      const id = Number(getProviderIdCI(item.ProviderIds as Record<string, string> | undefined, "Tmdb"));
      return { itemId, type: "Movie", path, etag, seriesId: null, tmdb: Number.isInteger(id) && id > 0 ? { kind: "movie", id } : null, durationS };
    }
    const seriesId = item.SeriesId && isJellyfinId(item.SeriesId) ? item.SeriesId : null;
    const season = positiveInt(item.ParentIndexNumber);
    const episode = positiveInt(item.IndexNumber);
    const tvId = seriesId ? await seriesTmdbId(seriesId) : null;
    const tmdbRef: TmdbRef | null = tvId && season !== null && episode !== null ? { kind: "episode", tvId, season, episode } : null;
    return { itemId, type: "Episode", path, etag, seriesId, tmdb: tmdbRef, durationS };
  });
}

/**
 * L'identifiant TMDB d'une série : Jellyfin ne le met que sur la série, jamais sur l'épisode. Une série
 * que Jellyfin ne connaît que par TVDB passe par la recherche de TMDB (`find`).
 */
async function seriesTmdbId(seriesId: string): Promise<number | null> {
  const series = await jellyfin.getItemForAnalysis(seriesId);
  const ids = series?.ProviderIds as Record<string, string> | undefined;
  const direct = Number(getProviderIdCI(ids, "Tmdb"));
  if (Number.isInteger(direct) && direct > 0) return direct;
  const tvdb = Number(getProviderIdCI(ids, "Tvdb"));
  if (!Number.isInteger(tvdb) || tvdb <= 0) return null;
  const found = await withPersistentCache(`credits:xray:v1:tvdb:${tvdb}`, WEEK_MS, async () => (await tmdb.findTvByTvdbId(tvdb)).tv_results?.[0]?.id ?? 0);
  return found > 0 ? found : null;
}

function project(person: TmdbCreditedPerson, order: number): XrayPerson {
  return {
    personId: person.id,
    name: person.name,
    character: (person.character ?? "").trim(),
    order,
    profilePath: person.profile_path ?? null,
  };
}

const byOrder = (a: TmdbCreditedPerson, b: TmdbCreditedPerson) => (a.order ?? 9999) - (b.order ?? 9999);

/**
 * La distribution d'un épisode — ses rôles réguliers crédités, puis les invités — ou d'un film, dans
 * l'ordre du générique, une personne une fois (un acteur crédité deux fois garde ses deux rôles, joints),
 * `XRAY_CAST_MAX` au plus. Une semaine sur disque.
 */
export function castOf(ref: TmdbRef): Promise<XrayPerson[]> {
  const key = ref.kind === "movie" ? `credits:xray:v1:movie:${ref.id}` : `credits:xray:v1:episode:${ref.tvId}:${ref.season}:${ref.episode}`;
  return withPersistentCache(key, WEEK_MS, async () => {
    const people =
      ref.kind === "movie"
        ? [...((await tmdb.getMovieCredits(ref.id)).cast ?? [])].sort(byOrder)
        : await tmdb.getEpisodeCredits(ref.tvId, ref.season, ref.episode).then((c) => [...(c.cast ?? [])].sort(byOrder).concat([...(c.guest_stars ?? [])].sort(byOrder)));
    const out: XrayPerson[] = [];
    const seen = new Map<number, XrayPerson>();
    for (const person of people) {
      if (typeof person?.id !== "number" || !person.name) continue;
      const known = seen.get(person.id);
      if (known) {
        const character = (person.character ?? "").trim();
        if (character && !known.character.split(" / ").includes(character)) known.character = known.character ? `${known.character} / ${character}` : character;
        continue;
      }
      if (out.length >= XRAY_CAST_MAX) continue;
      const entry = project(person, out.length);
      seen.set(person.id, entry);
      out.push(entry);
    }
    return out;
  });
}

/** Les meilleures photos d'une personne chez TMDB (chemins), par note — une semaine sur disque. */
function photosOf(personId: number): Promise<string[]> {
  return withPersistentCache(`person:xray-photos:v1:${personId}`, WEEK_MS, async () => {
    const data = await tmdb.getPersonImages(personId);
    return [...(data.profiles ?? [])]
      .sort((a, b) => b.vote_average - a.vote_average)
      .map((p) => p.file_path)
      .filter((p): p is string => typeof p === "string" && p.startsWith("/"))
      .slice(0, XRAY_PHOTOS_PER_PERSON);
  });
}

/**
 * La distribution telle que le service l'attend : la photo principale d'abord, puis les autres, en
 * adresses `image.tmdb.org` (le service refuse toute autre). Une personne dont l'album ne répond pas
 * garde sa photo principale ; une personne sans aucune photo est envoyée quand même — le service peut
 * la reconnaître dans une autre analyse de la série. Six requêtes à la fois au plus vers TMDB.
 */
export async function castWithPhotos(cast: readonly XrayPerson[]): Promise<{ personId: number; name: string; character: string; order: number; photos: string[] }[]> {
  return mapInBatches(cast, 6, async (person) => {
    const album = await photosOf(person.personId).catch(() => [] as string[]);
    const paths = [...new Set([...(person.profilePath ? [person.profilePath] : []), ...album])].slice(0, XRAY_PHOTOS_PER_PERSON);
    return { personId: person.personId, name: person.name, character: person.character, order: person.order, photos: paths.map(tmdbPhotoUrl) };
  });
}

/**
 * L'épisode qui suit dans la série — la règle de `nextEpisodeIn` (une saison enchaîne sur la suivante,
 * les spéciaux entre eux), sur la liste du serveur plutôt que sur celle d'un compte. `null` après le dernier.
 */
export function nextEpisodeAfter(
  episodes: readonly { Id: string; ParentIndexNumber?: number | null; IndexNumber?: number | null }[],
  itemId: string
): string | null {
  const numbered = episodes.filter((e) => positiveInt(e.ParentIndexNumber) !== null && positiveInt(e.IndexNumber) !== null);
  const current = numbered.find((e) => e.Id === itemId);
  if (!current) return null;
  const specials = current.ParentIndexNumber === 0;
  const chain = numbered
    .filter((e) => (e.ParentIndexNumber === 0) === specials)
    .sort((a, b) => a.ParentIndexNumber! - b.ParentIndexNumber! || a.IndexNumber! - b.IndexNumber!);
  const index = chain.findIndex((e) => e.Id === itemId);
  const next = index >= 0 ? chain[index + 1] : undefined;
  return next && isJellyfinId(next.Id) ? next.Id : null;
}

import { createTmdbClient, pickTrailer, tmdb, videoLanguages, type TmdbTranslations } from "@/lib/clients/tmdb";
import { kvCacheDb } from "@/lib/db";
import { logError } from "@/lib/logger";
import { LOCALES, getTmdbLocale, type Locale } from "@/lib/i18n";
import { withSlot } from "@/lib/title-art";
import { spreadTtl } from "@/lib/cacheSpread";

/**
 * Le titre d'un film ou d'une série dans chacune des langues de l'interface.
 *
 * Le catalogue affichait le titre de Radarr et de Sonarr, qui ne connaissent que l'anglais : *Le
 * Prénom* s'appelait « What's in a Name » et *Le Retour de Martin Guerre* « The Return of Martin
 * Guerre » pour un foyer francophone, juste sous une affiche qui portait le titre français
 * (23/09/2026). Même défaut, même remède que les affiches (`posterByLang`) : tout est retenu
 * ici, et le choix se fait à l'affichage, parce que le catalogue est commun et que la langue
 * appartient à chacun.
 *
 * **Jamais bloquant.** Un titre dont la traduction n'est pas encore connue part sous son nom
 * actuel, et la traduction est cherchée en arrière-plan pour la requête suivante. Sans ça, la
 * première ouverture du catalogue après un déploiement aurait attendu un millier d'appels à TMDB,
 * et chaque expiration aurait recommencé. Une traduction connue est resservie même périmée,
 * pendant qu'on la rafraîchit : un titre ne change pratiquement jamais.
 */
export type TitleNames = Partial<Record<Locale, string>>;

/**
 * Le synopsis dans chaque langue, tiré de la même réponse de TMDB que les titres.
 *
 * Le catalogue portait le résumé de Radarr, en anglais, et la fiche le remplaçait par celui de
 * TMDB dans la langue de qui regarde une fois sa description arrivée — un texte qui changeait sous
 * les yeux. Depuis que la fiche s'ouvre complète (25/09/2026) et ne remplace plus rien, c'est le
 * catalogue qui doit porter le bon texte : il le prend ici, comme le titre. La langue d'origine
 * n'est pas une traduction chez TMDB : un film français garde le résumé du catalogue.
 */
export type TitleOverviews = Partial<Record<Locale, string>>;

// Sous les trente jours après lesquels le ménage du cache disque efface une entrée : rafraîchie
// avant d'être effacée, une traduction ne redevient jamais inconnue.
const TTL_MS = 14 * 24 * 3600_000;
// `v2` : la forme lue a changé (la langue d'origine s'y ajoute). Une entrée `v1` relue telle quelle
// laisserait les films français sous leur titre anglais pendant deux semaines.
/** Le pays qu'on préfère quand une langue a plusieurs traductions : fr-FR plutôt que fr-CA. */
const HOME_COUNTRY: Record<Locale, string> = { fr: "FR", en: "US", es: "ES", de: "DE" };

const memory = new Map<string, { names: TitleNames; fetchedAt: number }>();
const refreshing = new Set<string>();
/**
 * Un titre dont la recherche vient d'échouer n'est pas redemandé avant une heure : pendant une
 * panne de TMDB, ou pour un identifiant qu'il ne connaît plus, chaque ouverture du catalogue
 * relançait l'appel — et écrivait une ligne d'erreur de plus.
 */
const RETRY_AFTER_FAILURE_MS = 3600_000;
const failedAt = new Map<string, number>();

/** Pour les tests. */
export function resetTitleNames(): void {
  memory.clear();
  overviewMemory.clear();
  extrasMemory.clear();
  refreshing.clear();
  failedAt.clear();
}

export function namesFromTranslations(data: TmdbTranslations): TitleNames {
  const out: TitleNames = {};
  const translations = data.translations?.translations ?? [];
  for (const locale of LOCALES) {
    // La langue d'origine n'est pas une traduction : TMDB ne la liste pas. Constaté sur *Le
    // Retour de Martin Guerre*, qui avait un titre en anglais, en espagnol, en allemand — et
    // aucun en français.
    const original = data.original_title || data.original_name;
    if (data.original_language === locale && original) {
      out[locale] = original.trim();
      continue;
    }
    const candidates = translations.filter((t) => t.iso_639_1 === locale);
    const ordered = [
      ...candidates.filter((t) => t.iso_3166_1 === HOME_COUNTRY[locale]),
      ...candidates.filter((t) => t.iso_3166_1 !== HOME_COUNTRY[locale]),
    ];
    for (const t of ordered) {
      const name = (t.data?.title || t.data?.name || "").trim();
      if (name) {
        out[locale] = name;
        break;
      }
    }
  }
  return out;
}

export function overviewsFromTranslations(data: TmdbTranslations): TitleOverviews {
  const out: TitleOverviews = {};
  const translations = data.translations?.translations ?? [];
  for (const locale of LOCALES) {
    const candidates = translations.filter((t) => t.iso_639_1 === locale);
    const ordered = [
      ...candidates.filter((t) => t.iso_3166_1 === HOME_COUNTRY[locale]),
      ...candidates.filter((t) => t.iso_3166_1 !== HOME_COUNTRY[locale]),
    ];
    for (const t of ordered) {
      const text = (t.data?.overview || "").trim();
      if (text) {
        out[locale] = text;
        break;
      }
    }
  }
  return out;
}

const overviewMemory = new Map<string, TitleOverviews>();
const overviewKey = (namesKey: string) => namesKey.replace("tmdb:titles:v2:", "tmdb:overviews:v1:");

/**
 * L'accroche et la bande-annonce d'un titre, pour chacune des quatre langues (08/10/2026).
 *
 * Elles n'arrivaient qu'avec la description complète d'une fiche (Radarr, Bazarr, OMDb, TMDB) et
 * s'y posaient en décalé, une demi-seconde après tout le reste. Rangées avec le catalogue — et donc
 * dans le cache qu'il a sur l'appareil —, elles sont là dès l'ouverture. Elles viennent du même appel
 * que les titres et les synopsis (`append_to_response=translations,videos`) : rien de plus à TMDB,
 * sauf une accroche dans la langue d'origine, que TMDB ne range pas parmi les traductions.
 *
 * Une langue sans accroche est une chaîne vide, et un titre sans bande-annonce `null` : c'est ce qui
 * distingue « rien à montrer » de « pas encore su » (l'entrée absente).
 */
export interface TitleExtras {
  taglines: Partial<Record<Locale, string>>;
  trailers: Partial<Record<Locale, string | null>>;
}
const extrasMemory = new Map<string, TitleExtras>();
const extrasKey = (namesKey: string) => namesKey.replace("tmdb:titles:v2:", "tmdb:extras:v1:");

export function extrasFromTranslations(data: TmdbTranslations): TitleExtras {
  const taglines: Partial<Record<Locale, string>> = {};
  const trailers: Partial<Record<Locale, string | null>> = {};
  const translations = data.translations?.translations ?? [];
  const videos = data.videos?.results ?? [];
  for (const locale of LOCALES) {
    const candidates = translations.filter((t) => t.iso_639_1 === locale);
    const ordered = [
      ...candidates.filter((t) => t.iso_3166_1 === HOME_COUNTRY[locale]),
      ...candidates.filter((t) => t.iso_3166_1 !== HOME_COUNTRY[locale]),
    ];
    taglines[locale] = ordered.map((t) => (t.data?.tagline || "").trim()).find(Boolean) ?? "";
    // Les mêmes langues de vidéo que la fiche (`videoLanguages`) : la bande-annonce retenue
    // d'avance est celle que la fiche aurait choisie.
    const accepted = videoLanguages(getTmdbLocale(locale)).split(",");
    trailers[locale] = pickTrailer(videos.filter((v) => accepted.includes(v.iso_639_1 ?? "null")))?.key ?? null;
  }
  // Demandés sans langue, les détails sont en anglais : pour un titre tourné en anglais, c'est son
  // accroche d'origine, absente des traductions.
  if (!taglines.en && data.original_language === "en" && data.tagline?.trim()) taglines.en = data.tagline.trim();
  return { taglines, trailers };
}

function refresh(key: string, tmdbId: number, mediaType: "movie" | "series"): void {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  void withSlot(() => (mediaType === "movie" ? tmdb.getMovieTranslations(tmdbId) : tmdb.getTvTranslations(tmdbId)))
    .then((data) => {
      const entry = { names: namesFromTranslations(data), fetchedAt: Date.now() };
      memory.set(key, entry);
      kvCacheDb.set(key, entry.names, entry.fetchedAt);
      // Les synopsis viennent de la même réponse : rangés à côté, sans appel de plus.
      const overviews = overviewsFromTranslations(data);
      overviewMemory.set(overviewKey(key), overviews);
      kvCacheDb.set(overviewKey(key), overviews, entry.fetchedAt);
      return completeOriginalTagline(extrasFromTranslations(data), data.original_language, tmdbId, mediaType).then((extras) => {
        extrasMemory.set(extrasKey(key), extras);
        kvCacheDb.set(extrasKey(key), extras, entry.fetchedAt);
      });
    })
    .catch((err) => {
      failedAt.set(key, Date.now());
      logError("title-names", err, { tmdbId, mediaType });
    })
    .finally(() => refreshing.delete(key));
}

/** Ce qu'on sait déjà de ce titre, tout de suite — et une recherche lancée s'il le faut. */
/**
 * L'accroche d'un titre dans sa langue d'origine, quand c'est une des quatre : TMDB ne la range pas
 * parmi les traductions (comme le titre, voir `namesFromTranslations`), et un film français n'avait
 * donc pas d'accroche française. Un appel de plus, pour ces titres-là seulement ; son échec laisse
 * l'accroche vide — la fiche la retrouve dans sa propre description.
 */
async function completeOriginalTagline(extras: TitleExtras, original: string | undefined, tmdbId: number, mediaType: "movie" | "series"): Promise<TitleExtras> {
  const locale = LOCALES.find((l) => l === original);
  // L'anglais est déjà là (les détails sont en anglais, voir `extrasFromTranslations`).
  if (!locale || locale === "en" || extras.taglines[locale]) return extras;
  try {
    const { tagline } = await withSlot(() => createTmdbClient(getTmdbLocale(locale)).getTagline(mediaType, tmdbId));
    return { ...extras, taglines: { ...extras.taglines, [locale]: (tagline ?? "").trim() } };
  } catch {
    return extras;
  }
}

/**
 * L'accroche et la bande-annonce connues pour ce titre, ou `null` si elles ne le sont pas encore —
 * la demande part alors en arrière-plan, comme pour les titres traduits. Une entrée d'avant le
 * 08/10/2026 n'en a pas : la première lecture du catalogue la complète.
 */
export function getTitleExtras(tmdbId: number | null | undefined, mediaType: "movie" | "series"): TitleExtras | null {
  try {
    if (!tmdbId || !tmdb.isEnabled()) return null;
    const key = `tmdb:titles:v2:${mediaType}:${tmdbId}`;
    const ekey = extrasKey(key);
    let extras = extrasMemory.get(ekey);
    if (!extras) {
      const disk = kvCacheDb.get(ekey);
      if (disk) {
        extras = disk.value as TitleExtras;
        extrasMemory.set(ekey, extras);
      }
    }
    if (!extras) {
      const recentlyFailed = Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_FAILURE_MS;
      if (!recentlyFailed) refresh(key, tmdbId, mediaType);
      return null;
    }
    return extras;
  } catch (err) {
    logError("title-names", err, { tmdbId, mediaType });
    return null;
  }
}

/** Les deux champs du catalogue : absents tant que rien n'est su, vides quand il n'y a rien. */
export function catalogueExtras(extras: TitleExtras | null, locale: Locale): { tagline?: string; trailerKey?: string | null } {
  if (!extras) return {};
  return { tagline: extras.taglines[locale] ?? "", trailerKey: extras.trailers[locale] ?? null };
}

export function getTitleNames(tmdbId: number | null | undefined, mediaType: "movie" | "series"): TitleNames {
  // Un ornement du catalogue ne doit jamais pouvoir l'emporter : une base qui refuse de lire, un
  // client TMDB absent, et c'est le titre d'avant qui s'affiche — pas un catalogue en erreur.
  try {
    return readTitleNames(tmdbId, mediaType);
  } catch (err) {
    logError("title-names", err, { tmdbId, mediaType });
    return {};
  }
}

function readTitleNames(tmdbId: number | null | undefined, mediaType: "movie" | "series"): TitleNames {
  if (!tmdbId || !tmdb.isEnabled()) return {};
  const key = `tmdb:titles:v2:${mediaType}:${tmdbId}`;
  let entry = memory.get(key);
  if (!entry) {
    const disk = kvCacheDb.get(key);
    if (disk) {
      entry = { names: disk.value as TitleNames, fetchedAt: disk.fetchedAt };
      memory.set(key, entry);
    }
  }
  // Étalée comme le reste (voir `spreadTtl`) : les 860 titres remplis le même jour ne
  // reviennent pas tous le même jour.
  const expired = !entry || Date.now() - entry.fetchedAt >= spreadTtl(key, TTL_MS);
  const recentlyFailed = Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_FAILURE_MS;
  if (expired && !recentlyFailed) refresh(key, tmdbId, mediaType);
  return entry?.names ?? {};
}

/**
 * Les synopsis connus de ce titre, tout de suite ; jamais bloquant, comme les titres. Un titre dont
 * les titres sont déjà en cache mais pas encore les synopsis (entrée d'avant le 25/09/2026) est
 * redemandé une fois, en arrière-plan.
 */
export function getTitleOverviews(tmdbId: number | null | undefined, mediaType: "movie" | "series"): TitleOverviews {
  try {
    if (!tmdbId || !tmdb.isEnabled()) return {};
    const key = `tmdb:titles:v2:${mediaType}:${tmdbId}`;
    const okey = overviewKey(key);
    let overviews = overviewMemory.get(okey);
    if (!overviews) {
      const disk = kvCacheDb.get(okey);
      if (disk) {
        overviews = disk.value as TitleOverviews;
        overviewMemory.set(okey, overviews);
      }
    }
    if (!overviews) {
      const recentlyFailed = Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_FAILURE_MS;
      if (!recentlyFailed) refresh(key, tmdbId, mediaType);
      return {};
    }
    return overviews;
  } catch (err) {
    logError("title-names", err, { tmdbId, mediaType });
    return {};
  }
}

/** Le synopsis à montrer : celui de la langue de qui regarde, sinon celui du catalogue. */
export function localizedOverview(overviews: TitleOverviews, locale: Locale, fallback: string | null): string | null {
  return overviews[locale] || fallback;
}

/**
 * Le titre à montrer : celui de la langue de qui regarde, sinon celui qu'on avait.
 *
 * Le titre remplacé reste cherchable : c'est souvent sous ce nom-là qu'on se souvient d'un film
 * étranger. Il est rendu à part, seulement quand il diffère — voir `aka` dans le catalogue.
 */
export function localizedTitle(names: TitleNames, locale: Locale, fallback: string): { title: string; aka?: string } {
  const title = names[locale] || fallback;
  return title === fallback ? { title } : { title, aka: fallback };
}

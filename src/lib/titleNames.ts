import { tmdb, type TmdbTranslations } from "@/lib/clients/tmdb";
import { kvCacheDb } from "@/lib/db";
import { logError } from "@/lib/logger";
import { LOCALES, type Locale } from "@/lib/i18n";
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

function refresh(key: string, tmdbId: number, mediaType: "movie" | "series"): void {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  void withSlot(() => (mediaType === "movie" ? tmdb.getMovieTranslations(tmdbId) : tmdb.getTvTranslations(tmdbId)))
    .then((data) => {
      const entry = { names: namesFromTranslations(data), fetchedAt: Date.now() };
      memory.set(key, entry);
      kvCacheDb.set(key, entry.names, entry.fetchedAt);
    })
    .catch((err) => {
      failedAt.set(key, Date.now());
      logError("title-names", err, { tmdbId, mediaType });
    })
    .finally(() => refreshing.delete(key));
}

/** Ce qu'on sait déjà de ce titre, tout de suite — et une recherche lancée s'il le faut. */
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
 * Le titre à montrer : celui de la langue de qui regarde, sinon celui qu'on avait.
 *
 * Le titre remplacé reste cherchable : c'est souvent sous ce nom-là qu'on se souvient d'un film
 * étranger. Il est rendu à part, seulement quand il diffère — voir `aka` dans le catalogue.
 */
export function localizedTitle(names: TitleNames, locale: Locale, fallback: string): { title: string; aka?: string } {
  const title = names[locale] || fallback;
  return title === fallback ? { title } : { title, aka: fallback };
}

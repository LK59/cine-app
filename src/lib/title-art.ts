import { tmdb, TMDB_IMAGE_BASE, type TmdbImage } from "@/lib/clients/tmdb";
import { withPersistentCache } from "@/lib/server-cache";
import { LOCALES, type Locale } from "@/lib/i18n";

export interface TitleArt {
  /** Le logo du titre — une image transparente, pas une affiche. `null` s'il n'y en a pas. */
  logoUrl: string | null;
  /**
   * Une affiche **sans texte**.
   *
   * TMDB range sous `iso_639_1: null` les visuels sans langue, c'est-à-dire, pour une affiche,
   * ceux dont le titre n'est pas imprimé dessus. C'est ce qu'il faut quand on pose déjà le logo
   * par-dessus : sinon le nom apparaît deux fois — une fois peint dans l'image, une fois écrit
   * par nous juste en dessous, ce qui était le cas de « Shameless ».
   *
   * `null` quand le titre n'en a pas : on retombe alors sur l'affiche ordinaire, avec son texte,
   * ce qui vaut toujours mieux qu'un visuel muet.
   */
  posterTextlessUrl: string | null;
  /**
   * L'affiche dans chacune des langues de l'interface, quand TMDB en a une.
   *
   * Signalé le 19/09/2026, capture à l'appui : « Le Prénom » s'affichait sous son titre français
   * dans la rangée des recommandations et sous « What's in a Name? » dans Ma liste. Les deux
   * disaient vrai à leur façon — les recommandations viennent de TMDB, interrogé dans la langue
   * du site, et tout le reste de Radarr, qui ne connaît qu'une affiche par film, celle que TMDB
   * sert par défaut. Deux sources pour une même chose, donc deux réponses.
   *
   * Elles sont toutes retenues ici, et le choix se fait à l'affichage : le catalogue est unique
   * et servi à tout le foyer, alors que la langue, elle, appartient à chacun.
   */
  posterByLang: Partial<Record<Locale, string>>;
}

const EMPTY: TitleArt = { logoUrl: null, posterTextlessUrl: null, posterByLang: {} };

/**
 * Une file d'attente pour les appels à TMDB.
 *
 * La route du catalogue résout toute la bibliothèque d'un coup, avec un `Promise.all` sur un
 * millier de titres. Tant que le cache disque est chaud, ce sont mille lectures locales et rien
 * d'autre ; mais la toute première fois — un cache neuf, ou une clé qui vient de changer — c'est
 * un millier de requêtes simultanées vers TMDB, qui répond alors 429 à la moitié. Les échecs ne
 * sont pas mis en cache (voir `withPersistentCache`), donc rien ne se corrompt, mais la première
 * ouverture est longue et bruyante.
 *
 * Douze à la fois : le remplissage complet prend une poignée de secondes au lieu d'être refusé,
 * et le cas courant — tout est déjà en cache — ne passe même pas par ici.
 */
const MAX_CONCURRENT = 12;
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function pickLogo(logos: TmdbImage[]): string | null {
  if (logos.length === 0) return null;
  // Français d'abord (la langue par défaut de cette application), puis anglais, puis sans langue
  // — souvent lisible quand même —, puis n'importe lequel plutôt que rien.
  const byLang = (lang: string | null) => logos.filter((l) => l.iso_639_1 === lang);
  const pool =
    byLang("fr").length > 0 ? byLang("fr") : byLang("en").length > 0 ? byLang("en") : byLang(null).length > 0 ? byLang(null) : logos;
  const best = [...pool].sort((a, b) => b.vote_average - a.vote_average)[0];
  return best ? `${TMDB_IMAGE_BASE}/w500${best.file_path}` : null;
}

function pickTextlessPoster(posters: TmdbImage[]): string | null {
  const textless = posters.filter((p) => p.iso_639_1 === null);
  if (textless.length === 0) return null;
  const best = [...textless].sort((a, b) => b.vote_average - a.vote_average)[0];
  // w500 : c'est la taille du visuel principal du téléphone, où l'affiche occupe toute la
  // largeur. Le CDN sert directement cette taille — rien ne repasse par ce serveur.
  return best ? `${TMDB_IMAGE_BASE}/w500${best.file_path}` : null;
}

/**
 * La meilleure affiche de chaque langue, quand il y en a une.
 *
 * `w342`, la taille des vignettes de rangée — la même que celle demandée aux visuels de Radarr,
 * pour que remplacer l'un par l'autre ne change rien au poids ni à la netteté.
 */
function postersByLang(posters: TmdbImage[]): Partial<Record<Locale, string>> {
  const out: Partial<Record<Locale, string>> = {};
  for (const locale of LOCALES) {
    const best = posters
      .filter((p) => p.iso_639_1 === locale)
      .sort((a, b) => b.vote_average - a.vote_average)[0];
    if (best) out[locale] = `${TMDB_IMAGE_BASE}/w342${best.file_path}`;
  }
  return out;
}

/**
 * Le logo d'un titre et son affiche sans texte, en un seul appel et une seule entrée de cache.
 *
 * Les deux sortent de la même réponse `/images` de TMDB, qui était déjà demandée pour le logo :
 * lire les affiches au passage ne coûte donc rien de plus, ni en requêtes ni en latence. Mis en
 * cache une semaine sur disque, comme le logo l'était — ces visuels ne changent pratiquement
 * jamais une fois déposés.
 */
export async function getTitleArt(tmdbId: number, mediaType: "movie" | "series"): Promise<TitleArt> {
  if (!tmdb.isEnabled() || !tmdbId) return EMPTY;
  // `v2` : la forme a changé (les affiches par langue s'y ajoutent), et une entrée de la version
  // précédente relue telle quelle rendrait un catalogue sans aucune affiche localisée pendant une
  // semaine, sans que rien ne le signale.
  return withPersistentCache<TitleArt>(`tmdb:art:v2:${mediaType}:${tmdbId}`, 7 * 24 * 3600_000, async () => {
    const images = await withSlot(() =>
      mediaType === "movie" ? tmdb.getMovieImages(tmdbId) : tmdb.getTvImages(tmdbId)
    );
    return {
      logoUrl: pickLogo(images.logos ?? []),
      posterTextlessUrl: pickTextlessPoster(images.posters ?? []),
      posterByLang: postersByLang(images.posters ?? []),
    };
  }).catch(() => EMPTY);
}

import { tmdb, TMDB_IMAGE_BASE, type TmdbImage } from "@/lib/clients/tmdb";
import { withPersistentCache } from "@/lib/server-cache";
import { kvCacheDb } from "@/lib/db";
import { logoIsDark } from "@/lib/logoLuminance";
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

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * Le logo à montrer : français d'abord (la langue par défaut de cette application), puis anglais,
 * puis sans langue — souvent lisible quand même —, puis n'importe lequel ; dans chaque groupe, le
 * mieux noté par les votes de TMDB.
 *
 * **Jamais un logo trop sombre pour nos fonds** (09/10/2026, voir `logoLuminance.ts`) : dans l'ordre
 * ci-dessus, le premier qui se lit. L'ordre des langues ne change pas — un logo noir ne fait passer à
 * l'anglais que si aucun logo français ne se lit. Si aucun logo ne se lit, aucun : le titre écrit
 * s'affiche à la place, alors qu'un logo noir ne se verrait nulle part (fiche, bannière et lecteur
 * sont tous sombres). Seuls les logos nécessaires sont mesurés : on s'arrête au premier lisible.
 */
/** Les titres dont la valeur `v3` a été vérifiée dans ce processus — voir `getTitleArt`. */
const upgraded = new Set<string>();

export async function pickLogo(
  logos: readonly TmdbImage[],
  isDark: (filePath: string) => Promise<boolean | null> = (filePath) => withSlot(() => logoIsDark(filePath)),
): Promise<string | null> {
  if (logos.length === 0) return null;
  const byVotes = (list: readonly TmdbImage[]) => [...list].sort((a, b) => b.vote_average - a.vote_average);
  const groups: TmdbImage[][] = [];
  const seen = new Set<TmdbImage>();
  for (const lang of ["fr", "en", null] as const) {
    const group = byVotes(logos.filter((l) => l.iso_639_1 === lang));
    group.forEach((l) => seen.add(l));
    if (group.length > 0) groups.push(group);
  }
  const rest = byVotes(logos.filter((l) => !seen.has(l)));
  if (rest.length > 0) groups.push(rest);
  for (const group of groups) {
    for (const logo of group) {
      // `null` (mesure impossible) compte comme lisible : une panne ne retire pas de logo.
      if ((await isDark(logo.file_path)) !== true) return `${TMDB_IMAGE_BASE}/w500${logo.file_path}`;
    }
  }
  return null;
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
  // `v3` (09/10/2026) : le logo choisi écarte désormais les logos trop sombres. `v2` avait changé la
  // forme (les affiches par langue s'y ajoutaient).
  const key = `tmdb:art:v3:${mediaType}:${tmdbId}`;
  const compute = () =>
    withPersistentCache<TitleArt>(key, 7 * 24 * 3600_000, async () => {
      const images = await withSlot(() =>
        mediaType === "movie" ? tmdb.getMovieImages(tmdbId) : tmdb.getTvImages(tmdbId)
      );
      return {
        logoUrl: await pickLogo(images.logos ?? []),
        posterTextlessUrl: pickTextlessPoster(images.posters ?? []),
        posterByLang: postersByLang(images.posters ?? []),
      };
    });
  /**
   * Le passage de `v2` à `v3` sans catalogue lent.
   *
   * Le catalogue attend le visuel de chacun de ses mille titres. Avec une clé neuve, la première
   * réponse aurait attendu mille appels à TMDB plus mille mesures de logo, douze à la fois — des
   * dizaines de secondes d'écran de chargement le jour du déploiement. Tant qu'un titre n'a pas sa
   * valeur `v3`, on sert sa valeur `v2` telle quelle et on calcule la `v3` en arrière-plan ; la
   * réponse suivante du catalogue la prend. Vérifié une fois par titre et par processus, pour que le
   * cas courant (tout est déjà en `v3`) ne coûte pas une lecture de base par titre et par requête.
   */
  if (!upgraded.has(key)) {
    upgraded.add(key);
    try {
      if (!kvCacheDb.get(key)) {
        const previous = kvCacheDb.get(`tmdb:art:v2:${mediaType}:${tmdbId}`);
        if (previous) {
          void compute().catch(() => upgraded.delete(key));
          return previous.value as TitleArt;
        }
      }
    } catch {
      /* une base qui ne répond pas : on calcule comme avant */
    }
  }
  return compute().catch(() => EMPTY);
}

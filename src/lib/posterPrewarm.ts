/**
 * Les affiches du catalogue préparées d'avance, dans les tailles que les écrans demandent.
 *
 * Une affiche passe par l'optimiseur de Next (`/_next/image`), qui la télécharge chez TMDB ou
 * TheTVDB, la réduit et la range dans `data/image-cache` — une entrée par adresse, largeur et
 * qualité. La première demande d'une taille coûte 60 à 350 ms (mesuré le 25/09/2026), les
 * suivantes 2 à 3 ms. Ce premier coût tombait sur la première personne qui ouvrait l'écran : un
 * film tout juste ajouté, une largeur jamais demandée par cet appareil, et les affiches « se
 * génèrent au fur et à mesure » (Louis, 25/09/2026).
 *
 * Le serveur les demande donc lui-même à son propre optimiseur, en arrière-plan : au démarrage,
 * puis régulièrement pour les titres apparus depuis. C'est l'optimiseur réel qui répond, donc la
 * même entrée de cache que celle qu'un navigateur demandera — aucune seconde copie.
 *
 * Doucement : deux demandes à la fois au plus, jamais pendant les premières secondes du
 * démarrage, et un arrêt net si l'optimiseur se met à refuser.
 */

import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { getTitleArt } from "@/lib/title-art";
import { libraryPoster } from "@/lib/images";
import { LOCALES, type Locale } from "@/lib/i18n";

/**
 * Les largeurs préparées par défaut. Relevées dans le journal du relais le 25/09/2026 sur 8 329
 * demandes à `/_next/image` : `w=750` (3 620) et `w=384` (3 341) en font 83 % — une affiche de carte
 * sur un écran à forte densité, et la grille des téléphones. `w=640` (905) suit ; le reste est
 * marginal. Toutes appartiennent aux tailles que Next accepte (`imageSizes` et `deviceSizes` par
 * défaut) : une largeur hors liste serait refusée par l'optimiseur.
 */
export const DEFAULT_WIDTHS = [384, 750];
/** La qualité par défaut de next/image, la seule que les écrans demandent (`q=75`). */
export const QUALITY = 75;
/** Deux à la fois : le serveur est partagé avec la lecture, et rien ne presse. */
export const CONCURRENCY = 2;
/** Au-delà de ce nombre d'échecs d'affilée, l'optimiseur est considéré comme hors service. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Le premier passage attend que le serveur écoute et que les catalogues soient chauds. */
const FIRST_RUN_DELAY_MS = 60_000;
/** Puis un passage régulier : les titres ajoutés entre-temps, et rien d'autre. */
const INTERVAL_MS = 30 * 60_000;

/**
 * Les hôtes que l'optimiseur accepte — les mêmes que `images.remotePatterns` dans next.config.js.
 * Une adresse ailleurs serait refusée par Next ; la demander ne coûterait qu'un 400, mais n'aurait
 * aucun sens.
 */
const OPTIMIZABLE = [/^https:\/\/image\.tmdb\.org\/t\/p\//, /^https:\/\/artworks\.thetvdb\.com\/banners\//];

export function isOptimizable(url: string | null | undefined): url is string {
  return typeof url === "string" && OPTIMIZABLE.some((re) => re.test(url));
}

export interface PrewarmSettings {
  enabled: boolean;
  widths: number[];
  locales: Locale[];
}

/**
 * L'interrupteur et ses réglages, lus dans l'environnement.
 *
 * `POSTER_PREWARM` (vrai par défaut), `POSTER_PREWARM_WIDTHS` (« 384,750 ») et
 * `POSTER_PREWARM_LOCALES` : l'affiche dépend de la langue de qui regarde (`libraryPoster`), et
 * cette langue vient d'un cookie, pas du compte. Le français, langue par défaut du cinéma quand le
 * cookie manque (`localeOf`), plus la langue de l'installation.
 */
export function prewarmSettings(env: Record<string, string | undefined> = process.env): PrewarmSettings {
  const enabled = (env.POSTER_PREWARM ?? "true") !== "false";
  const widths = (env.POSTER_PREWARM_WIDTHS ?? DEFAULT_WIDTHS.join(","))
    .split(",")
    .map((w) => Number(w.trim()))
    .filter((w) => Number.isInteger(w) && w > 0 && w <= 3840);
  const wanted = env.POSTER_PREWARM_LOCALES
    ? env.POSTER_PREWARM_LOCALES.split(",").map((l) => l.trim())
    : ["fr", env.APP_LANGUAGE ?? "fr"];
  const locales = [...new Set(wanted)].filter((l): l is Locale => (LOCALES as string[]).includes(l));
  return { enabled, widths: widths.length ? widths : DEFAULT_WIDTHS, locales: locales.length ? locales : ["fr"] };
}

/** L'adresse que next/image demande pour cette affiche et cette largeur — à l'octet près. */
export function variantPath(url: string, width: number, quality = QUALITY): string {
  return `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=${quality}`;
}

/**
 * Les affiches du catalogue, par la même règle que les routes du cinéma (`libraryPoster` sur
 * `getTitleArt`) : ce sont exactement les adresses que les cartes passent à l'optimiseur. Les
 * films sans fichier ne sont pas à l'écran ; les préparer ne servirait à rien.
 */
export async function collectPosterUrls(locales: Locale[]): Promise<string[]> {
  const [movies, series] = await Promise.all([cachedMovies(), cachedSeries()]);
  const urls = new Set<string>();
  for (const m of movies) {
    if (!m.hasFile) continue;
    const art = await getTitleArt(m.tmdbId, "movie");
    for (const locale of locales) {
      const url = libraryPoster(art.posterByLang, m.images, locale);
      if (isOptimizable(url)) urls.add(url);
    }
  }
  for (const s of series) {
    const art = await getTitleArt(s.tmdbId ?? 0, "series");
    for (const locale of locales) {
      const url = libraryPoster(art.posterByLang, s.images, locale);
      if (isOptimizable(url)) urls.add(url);
    }
  }
  return [...urls];
}

export interface PrewarmResult {
  prepared: number;
  alreadyDone: number;
  failed: number;
  stoppedEarly: boolean;
  ms: number;
}

/**
 * Demande à l'optimiseur chaque variante pas encore faite. `done` retient ce qui a réussi, pour
 * que les passages suivants ne redemandent rien — même un HIT à 2 ms, multiplié par tout le
 * catalogue toutes les demi-heures, ne sert personne.
 */
export async function prewarmPosters(
  urls: string[],
  options: {
    widths: number[];
    base: string;
    done: Set<string>;
    fetchImpl?: typeof fetch;
    concurrency?: number;
  }
): Promise<PrewarmResult> {
  const started = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const queue: string[] = [];
  let alreadyDone = 0;
  for (const url of urls) {
    if (!isOptimizable(url)) continue;
    for (const width of options.widths) {
      const path = variantPath(url, width);
      if (options.done.has(path)) alreadyDone += 1;
      else queue.push(path);
    }
  }

  let prepared = 0;
  let failed = 0;
  let consecutive = 0;
  let stoppedEarly = false;
  const worker = async () => {
    while (queue.length > 0 && !stoppedEarly) {
      const path = queue.shift()!;
      try {
        // Le même en-tête qu'un navigateur : l'optimiseur choisit le format d'après lui, et le
        // format fait partie de la clé de cache. `formats` n'étant pas réglé, c'est du WebP.
        const res = await fetchImpl(`${options.base}${path}`, { headers: { Accept: "image/webp,image/*,*/*;q=0.8" } });
        // Lu jusqu'au bout : une réponse abandonnée garde sa connexion ouverte.
        await res.arrayBuffer().catch(() => undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        options.done.add(path);
        prepared += 1;
        consecutive = 0;
      } catch {
        failed += 1;
        consecutive += 1;
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) stoppedEarly = true;
      }
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? CONCURRENCY, queue.length || 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return { prepared, alreadyDone, failed, stoppedEarly, ms: Date.now() - started };
}

let started = false;
const done = new Set<string>();

/**
 * Lance le préchauffage : un premier passage une minute après le démarrage, puis toutes les
 * demi-heures. Ne lève jamais — une affiche non préparée se prépare quand même à sa première
 * demande, comme avant.
 */
export function startPosterPrewarm(settings: PrewarmSettings = prewarmSettings()): boolean {
  if (!settings.enabled || started) return false;
  started = true;
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const urls = await collectPosterUrls(settings.locales);
      const result = await prewarmPosters(urls, { widths: settings.widths, base, done });
      if (result.prepared > 0 || result.failed > 0) {
        console.log(
          `[affiches] ${result.prepared} préparées, ${result.alreadyDone} déjà faites, ${result.failed} en échec` +
            `${result.stoppedEarly ? " (optimiseur injoignable : arrêt)" : ""} — ${urls.length} affiches × ` +
            `${settings.widths.join("/")} px, ${(result.ms / 1000).toFixed(1)} s`
        );
      }
    } catch (error) {
      console.error(`[affiches] préchauffage interrompu : ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), FIRST_RUN_DELAY_MS);
  const every = setInterval(() => void run(), INTERVAL_MS);
  // Ne retient pas le processus : un arrêt du serveur n'attend pas le prochain passage.
  first.unref?.();
  every.unref?.();
  return true;
}
